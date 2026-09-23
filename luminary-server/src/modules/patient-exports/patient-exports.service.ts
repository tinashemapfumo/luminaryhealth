import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';
import { can } from '../../platform/permissions.js';
import { Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import {
  allocatePatientExportFile, patientFileStream, removePatientFile, storedFileMetadata,
} from '../../platform/file-storage.js';
import type { Actor } from '../billing/billing.service.js';

export const EXPORT_SECTIONS = ['summary', 'clinical', 'appointments', 'billing', 'documents'] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

interface ExportJob {
  id: string;
  practice_id: string;
  patient_id: string;
  requested_by: string;
  purpose: string;
  included_sections: ExportSection[];
  date_from: string | null;
  date_to: string | null;
  status: string;
  storage_key: string | null;
  checksum: string | null;
  size_bytes: string | null;
  expires_at: string;
  downloaded_at: string | null;
}

const printable = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
};

async function pdfBuffer(title: string, groups: Array<{ heading: string; rows: Record<string, unknown>[] }>) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title, Producer: 'Luminary Health' } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(18).text(title).moveDown();
  doc.fontSize(9).fillColor('#555').text(`Generated ${new Date().toISOString()}`).fillColor('#000').moveDown();
  for (const group of groups) {
    doc.fontSize(13).text(group.heading).moveDown(0.4);
    if (group.rows.length === 0) doc.fontSize(10).fillColor('#555').text('No records in the selected range.').fillColor('#000');
    for (const row of group.rows) {
      for (const [key, value] of Object.entries(row)) {
        doc.fontSize(9).font('Helvetica-Bold').text(`${key.replaceAll('_', ' ')}:`, { continued: true });
        doc.font('Helvetica').text(` ${printable(value)}`);
      }
      doc.moveDown(0.6);
    }
    doc.moveDown();
  }
  doc.end();
  return complete;
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safeFilename = (value: string) => value.replace(/[^a-zA-Z0-9._ -]+/g, '_').slice(0, 120) || 'document';

async function rows(client: PoolClient, sql: string, values: unknown[]) {
  return (await client.query<Record<string, unknown>>(sql, values)).rows;
}

async function requirePatientAccess(client: PoolClient, actor: Actor, patientId: string) {
  const { rows: access } = await client.query<{ relationship: string | null }>(
    `SELECT luminary.care_relationship($1,$2) AS relationship`, [actor.userId, patientId],
  );
  if (!access[0]?.relationship) {
    throw new Forbidden('Open this chart with an authorized care relationship before exporting it');
  }
}

function requireSectionAccess(actor: Actor, sections: ExportSection[]) {
  if (sections.some((section) => ['summary','clinical','documents'].includes(section))
      && !can(actor.role, 'viewClinicalNotes')) {
    throw new Forbidden('Your role cannot include clinical content in an export');
  }
  if (sections.includes('billing') && !can(actor.role, 'readClaims')) {
    throw new Forbidden('Your role cannot include billing content in an export');
  }
}

export const patientExportsService = {
  async request(
    client: PoolClient,
    actor: Actor,
    patientId: string,
    input: { purpose: string; sections: ExportSection[]; dateFrom?: string; dateTo?: string },
  ) {
    if (!can(actor.role, 'exportPatientRecord')) throw new Forbidden('Your role cannot export patient records');
    requireSectionAccess(actor, input.sections);
    await requirePatientAccess(client, actor, patientId);
    const patient = await client.query(`SELECT id, full_name FROM luminary.patient WHERE id=$1 AND deleted_at IS NULL`, [patientId]);
    if (!patient.rows[0]) throw new NotFound('Patient not found');
    const { rows: created } = await client.query(
      `INSERT INTO luminary.patient_export_job
         (practice_id,patient_id,requested_by,purpose,included_sections,date_from,date_to)
       VALUES (luminary.current_practice_id(),$1,$2,$3,$4,$5,$6)
       RETURNING id,patient_id,status,included_sections,requested_at,expires_at`,
      [patientId, actor.userId, input.purpose.trim(), input.sections, input.dateFrom ?? null, input.dateTo ?? null],
    );
    await client.query(
      `SELECT luminary.write_audit('Requested patient file export','patient_export',$1,$2,$3,'alert')`,
      [created[0].id, patient.rows[0].full_name, input.sections.join(',')],
    );
    return created[0];
  },

  async list(client: PoolClient, actor: Actor, patientId: string) {
    if (!can(actor.role, 'exportPatientRecord')) throw new Forbidden('Your role cannot export patient records');
    await requirePatientAccess(client, actor, patientId);
    const patient = await client.query(`SELECT 1 FROM luminary.patient WHERE id=$1 AND deleted_at IS NULL`, [patientId]);
    if (!patient.rows[0]) throw new NotFound('Patient not found');
    return (await client.query(
      `SELECT id,status,purpose,included_sections,date_from,date_to,size_bytes,checksum,
              requested_at,completed_at,expires_at,downloaded_at,revoked_at,failure_code
         FROM luminary.patient_export_job
        WHERE patient_id=$1 AND deleted_at IS NULL ORDER BY requested_at DESC LIMIT 50`,
      [patientId],
    )).rows;
  },

  async status(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'exportPatientRecord')) throw new Forbidden('Your role cannot export patient records');
    const { rows } = await client.query(
      `SELECT id,patient_id,status,purpose,included_sections,date_from,date_to,size_bytes,checksum,
              requested_at,completed_at,expires_at,downloaded_at,revoked_at,failure_code
         FROM luminary.patient_export_job WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) throw new NotFound('Patient export not found');
    await requirePatientAccess(client, actor, rows[0].patient_id);
    return rows[0];
  },

  async takeForDownload(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'exportPatientRecord')) throw new Forbidden('Your role cannot export patient records');
    const visible = await client.query<{ patient_id: string }>(
      `SELECT patient_id FROM luminary.patient_export_job WHERE id=$1 AND deleted_at IS NULL`, [id],
    );
    if (!visible.rows[0]) throw new NotFound('Patient export not found');
    await requirePatientAccess(client, actor, visible.rows[0].patient_id);
    const { rows } = await client.query<ExportJob>(
      `SELECT * FROM luminary.patient_export_job
        WHERE id=$1 AND status='ready' AND downloaded_at IS NULL AND expires_at>now() AND deleted_at IS NULL
        FOR UPDATE`,
      [id],
    );
    const job = rows[0];
    if (!job?.storage_key) throw new Conflict('Export is unavailable, expired, or already downloaded');
    const stream = await patientFileStream(job.storage_key);
    await client.query(`UPDATE luminary.patient_export_job SET downloaded_at=now(),updated_at=now() WHERE id=$1`, [id]);
    await client.query(
      `SELECT luminary.write_audit('Downloaded patient file export','patient_export',$1,NULL,NULL,'alert')`,
      [id],
    );
    return { job, stream };
  },

  async revoke(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'exportPatientRecord')) throw new Forbidden('Your role cannot export patient records');
    const visible = await client.query<{ patient_id: string }>(
      `SELECT patient_id FROM luminary.patient_export_job WHERE id=$1 AND deleted_at IS NULL`, [id],
    );
    if (!visible.rows[0]) throw new NotFound('Patient export not found');
    await requirePatientAccess(client, actor, visible.rows[0].patient_id);
    const { rows } = await client.query<ExportJob>(
      `UPDATE luminary.patient_export_job
          SET status='revoked',revoked_at=now(),updated_at=now()
        WHERE id=$1 AND status IN ('pending','processing','ready') AND deleted_at IS NULL RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new Conflict('Export cannot be revoked in its current state');
    await client.query(`SELECT luminary.write_audit('Revoked patient file export','patient_export',$1,NULL,NULL,'alert')`, [id]);
    return rows[0];
  },

  async generate(client: PoolClient, jobId: string) {
    const jobResult = await client.query<ExportJob>(`SELECT * FROM luminary.patient_export_job WHERE id=$1 AND status='processing'`, [jobId]);
    const job = jobResult.rows[0];
    if (!job) throw new NotFound('Export job not found');
    const range = [job.patient_id, job.date_from, job.date_to];
    const patient = (await rows(client, `SELECT reference,full_name,date_of_birth,sex,national_id,phone,email,address_city,
      emergency_name,emergency_relation,emergency_phone,allergies,conditions,medications,blood_type,status
      FROM luminary.patient WHERE id=$1 AND deleted_at IS NULL`, [job.patient_id]))[0];
    if (!patient) throw new NotFound('Patient not found');

    const files: Array<{ name: string; bytes?: Buffer; stream?: Readable; checksum: string; size?: number }> = [];
    if (job.included_sections.includes('summary')) {
      const bytes = await pdfBuffer('Patient Summary', [{ heading: 'Patient', rows: [patient] }]);
      files.push({ name: 'Patient_Summary.pdf', bytes, checksum: digest(bytes), size: bytes.length });
    }
    if (job.included_sections.includes('clinical')) {
      const encounters = await rows(client, `SELECT e.id,e.note_type,e.status,e.vitals,e.subjective,e.objective,e.assessment,e.plan,e.diagnoses,e.follow_up,e.signed_at,u.display_name AS author
        FROM luminary.encounter e JOIN luminary.app_user u ON u.id=e.author_id
        WHERE e.patient_id=$1 AND e.status IN ('signed','amended') AND e.deleted_at IS NULL
          AND ($2::date IS NULL OR e.created_at::date >= $2) AND ($3::date IS NULL OR e.created_at::date <= $3)
        ORDER BY e.created_at`, range);
      const addenda = await rows(client, `SELECT a.encounter_id,a.body,a.created_at,u.display_name AS author
        FROM luminary.encounter_addendum a JOIN luminary.encounter e ON e.id=a.encounter_id JOIN luminary.app_user u ON u.id=a.author_id
        WHERE e.patient_id=$1 AND a.deleted_at IS NULL AND ($2::date IS NULL OR a.created_at::date >= $2) AND ($3::date IS NULL OR a.created_at::date <= $3)
        ORDER BY a.created_at`, range);
      const prescriptions = await rows(client, `SELECT drug,form,strength,dose,route,frequency,duration_days,quantity,refills,
          indication,pharmacy,substitution_allowed,instructions,status,issued_at,completed_at,cancelled_at,
          cancellation_reason,prescriber_name,prescriber_registration FROM luminary.prescription
        WHERE patient_id=$1 AND deleted_at IS NULL AND ($2::date IS NULL OR created_at::date >= $2) AND ($3::date IS NULL OR created_at::date <= $3) ORDER BY created_at`, range);
      const results = await rows(client, `SELECT test_name,value,unit,normal_range,abnormal,resulted_on,reviewed_at FROM luminary.lab_result
        WHERE patient_id=$1 AND deleted_at IS NULL AND ($2::date IS NULL OR resulted_on >= $2) AND ($3::date IS NULL OR resulted_on <= $3) ORDER BY resulted_on`, range);
      const referrals = await rows(client, `SELECT referred_to,specialty,reason,urgency,status,notes,sent_at,completed_at FROM luminary.referral
        WHERE patient_id=$1 AND status<>'draft' AND deleted_at IS NULL AND ($2::date IS NULL OR created_at::date >= $2) AND ($3::date IS NULL OR created_at::date <= $3) ORDER BY created_at`, range);
      const bytes = await pdfBuffer('Clinical Record', [
        { heading: 'Signed encounters', rows: encounters }, { heading: 'Addenda', rows: addenda },
        { heading: 'Prescriptions', rows: prescriptions }, { heading: 'Laboratory results', rows: results },
        { heading: 'Referrals', rows: referrals },
      ]);
      files.push({ name: 'Clinical_Record.pdf', bytes, checksum: digest(bytes), size: bytes.length });
    }
    if (job.included_sections.includes('appointments')) {
      const appointments = await rows(client, `SELECT a.starts_at,a.duration_min,a.visit_type,a.mode,a.status,u.display_name AS provider
        FROM luminary.appointment a LEFT JOIN luminary.app_user u ON u.id=a.provider_id
        WHERE a.patient_id=$1 AND a.deleted_at IS NULL AND ($2::date IS NULL OR a.starts_at::date >= $2) AND ($3::date IS NULL OR a.starts_at::date <= $3) ORDER BY a.starts_at`, range);
      const bytes = await pdfBuffer('Appointments', [{ heading: 'Appointment history', rows: appointments }]);
      files.push({ name: 'Appointments.pdf', bytes, checksum: digest(bytes), size: bytes.length });
    }
    if (job.included_sections.includes('billing')) {
      const invoices = await rows(client, `SELECT reference,issued_on,due_on,currency,total,scheme_portion,patient_portion,amount_paid,status
        FROM luminary.invoice WHERE patient_id=$1 AND deleted_at IS NULL AND ($2::date IS NULL OR issued_on >= $2) AND ($3::date IS NULL OR issued_on <= $3) ORDER BY issued_on`, range);
      const bytes = await pdfBuffer('Billing Record', [{ heading: 'Invoices', rows: invoices }]);
      files.push({ name: 'Billing.pdf', bytes, checksum: digest(bytes), size: bytes.length });
    }
    if (job.included_sections.includes('documents')) {
      const documents = await rows(client, `SELECT id,filename,content_type,byte_size,storage_key,checksum,created_at
        FROM luminary.patient_document WHERE patient_id=$1 AND deleted_at IS NULL
          AND ($2::date IS NULL OR created_at::date >= $2) AND ($3::date IS NULL OR created_at::date <= $3) ORDER BY created_at`, range);
      for (const document of documents) {
        files.push({
          name: `Documents/${String(document.id).slice(0, 8)}-${safeFilename(String(document.filename))}`,
          stream: await patientFileStream(String(document.storage_key)), checksum: String(document.checksum),
          size: Number(document.byte_size),
        });
      }
    }

    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1, exportId: job.id, patientId: job.patient_id, practiceId: job.practice_id,
      generatedAt: new Date().toISOString(), purpose: job.purpose, sections: job.included_sections,
      dateRange: { from: job.date_from, to: job.date_to },
      files: files.map((file) => ({ name: file.name, checksumSha256: file.checksum, sizeBytes: file.size ?? null })),
    }, null, 2));
    files.push({ name: 'manifest.json', bytes: manifest, checksum: digest(manifest), size: manifest.length });

    const stored = await allocatePatientExportFile({ practiceId: job.practice_id, patientId: job.patient_id, exportId: job.id });
    const output = createWriteStream(stored.absolutePath, { flags: 'wx', mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const finished = new Promise<void>((resolve, reject) => {
      output.on('close', resolve); output.on('error', reject); archive.on('error', reject);
    });
    archive.pipe(output);
    for (const file of files) archive.append(file.bytes ?? file.stream!, { name: file.name });
    await archive.finalize();
    await finished;
    const metadata = await storedFileMetadata(stored.storageKey);
    const updated = await client.query(
      `UPDATE luminary.patient_export_job SET status='ready',storage_key=$2,checksum=$3,size_bytes=$4,
              completed_at=now(),updated_at=now()
        WHERE id=$1 AND status='processing' RETURNING id,status,checksum,size_bytes,expires_at`,
      [job.id, stored.storageKey, metadata.checksum, metadata.sizeBytes],
    );
    if (!updated.rows[0]) {
      await removePatientFile(stored.storageKey);
      throw new Conflict('Export was revoked while it was being generated');
    }
    return updated.rows[0];
  },
};
