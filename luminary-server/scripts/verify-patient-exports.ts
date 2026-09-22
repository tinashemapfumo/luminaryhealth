import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, types, type PoolClient } from 'pg';
import type { Actor } from '../src/modules/billing/billing.service.js';
import { patientExportsService } from '../src/modules/patient-exports/patient-exports.service.js';
import { processPatientExports } from '../src/modules/patient-exports/patient-exports.worker.js';
import { closePool } from '../src/platform/db.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or MIGRATION_DATABASE_URL is required');
types.setTypeParser(1082, (value) => value);

let passed = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok ${passed} - ${message}`);
};
const consume = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='luminary_export_validation') THEN
    CREATE ROLE luminary_export_validation LOGIN PASSWORD 'validation_only';
  END IF;
END $$`);
await admin.query('GRANT luminary_app TO luminary_export_validation');

const ids = Object.fromEntries(['practiceA','practiceB','userA','userB','userNoAccess','managerA','patientA','patientB','appointment','encounter','addendum']
  .map((key) => [key, randomUUID()])) as Record<string, string>;
const suffix = randomUUID().slice(0, 8);
await admin.query('BEGIN');
try {
  await admin.query(`INSERT INTO luminary.practice(id,name,short_name) VALUES($1,$2,$3),($4,$5,$6)`,
    [ids.practiceA,`Export A ${suffix}`,`EA${suffix}`,ids.practiceB,`Export B ${suffix}`,`EB${suffix}`]);
  for (const [practice,user,patient,label] of [
    [ids.practiceA,ids.userA,ids.patientA,'a'], [ids.practiceB,ids.userB,ids.patientB,'b'],
  ]) {
    await admin.query(`SELECT set_config('luminary.practice_id',$1,true),set_config('luminary.user_id',$2,true),set_config('luminary.node','validation',true)`,[practice,user]);
    await admin.query(`INSERT INTO luminary.app_user(id,practice_id,email,full_name,display_name,role,is_provider)
      VALUES($1,$2,$3,$4,$4,'doctor',true)`,[user,practice,`export-${label}-${suffix}@test.invalid`,`Export Doctor ${label}`]);
    await admin.query(`INSERT INTO luminary.patient(id,practice_id,reference,full_name,date_of_birth,sex,phone,allergies,conditions)
      VALUES($1,$2,$3,$4,'1987-06-05','female','263771234567',ARRAY['penicillin'],ARRAY['hypertension'])`,
    [patient,practice,`EXP-${label}-${suffix}`,`Export Patient ${label}`]);
  }
  await admin.query(`SELECT set_config('luminary.practice_id',$1,true),set_config('luminary.user_id',$2,true)`,[ids.practiceA,ids.userA]);
  await admin.query(`INSERT INTO luminary.app_user(id,practice_id,email,full_name,display_name,role,is_provider) VALUES
    ($1,$3,$4,'Unrelated Doctor','Unrelated Doctor','doctor',true),
    ($2,$3,$5,'Practice Manager','Practice Manager','manager',false)`,
  [ids.userNoAccess,ids.managerA,ids.practiceA,`unrelated-${suffix}@test.invalid`,`manager-${suffix}@test.invalid`]);
  await admin.query(`INSERT INTO luminary.appointment(id,practice_id,patient_id,provider_id,starts_at,status)
    VALUES($1,$2,$3,$4,now()-interval '2 days','completed')`,[ids.appointment,ids.practiceA,ids.patientA,ids.userA]);
  await admin.query(`INSERT INTO luminary.encounter(id,practice_id,patient_id,appointment_id,author_id,status,subjective,assessment,plan,signed_by,signed_at)
    VALUES($1,$2,$3,$4,$5,'signed','Headache improved','Stable','Continue monitoring',$5,now()-interval '2 days')`,
  [ids.encounter,ids.practiceA,ids.patientA,ids.appointment,ids.userA]);
  await admin.query(`INSERT INTO luminary.encounter_addendum(id,practice_id,encounter_id,body,author_id)
    VALUES($1,$2,$3,'Patient confirmed improvement',$4)`,[ids.addendum,ids.practiceA,ids.encounter,ids.userA]);
  await admin.query('COMMIT');
} catch (error) { await admin.query('ROLLBACK'); throw error; }

const url = new URL(databaseUrl);
url.username = 'luminary_export_validation';
url.password = 'validation_only';
const runtime = new Client({ connectionString: url.toString() });
await runtime.connect();
const actor: Actor = { practiceId: ids.practiceA, userId: ids.userA, role: 'doctor' };
const context = async (client: Client, practiceId: string, userId = '') => {
  await client.query(`SELECT set_config('luminary.practice_id',$1,true),set_config('luminary.user_id',$2,true),set_config('luminary.node','validation',true)`,[practiceId,userId]);
};

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userNoAccess);
await assert.rejects(patientExportsService.request(runtime as unknown as PoolClient, {
  practiceId: ids.practiceA, userId: ids.userNoAccess, role: 'doctor',
}, ids.patientA, { purpose: 'TEST_UNRELATED', sections: ['clinical'] }));
await runtime.query('ROLLBACK');
passed += 1; console.log(`ok ${passed} - doctor without a care relationship cannot export the chart`);

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.managerA);
await assert.rejects(patientExportsService.request(runtime as unknown as PoolClient, {
  practiceId: ids.practiceA, userId: ids.managerA, role: 'manager',
}, ids.patientA, { purpose: 'TEST_MANAGER_CLINICAL', sections: ['clinical'] }));
await runtime.query('ROLLBACK');
passed += 1; console.log(`ok ${passed} - operational manager cannot include clinical content`);

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
const requested = await patientExportsService.request(runtime as unknown as PoolClient, actor, ids.patientA, {
  purpose: 'TEST_PROVIDER_TRANSFER', sections: ['summary','clinical','appointments'],
});
await runtime.query('COMMIT');
check(requested.status === 'pending', 'authorized doctor can request an asynchronous export');

await runtime.query('BEGIN');
const claimed = await runtime.query(`SELECT * FROM luminary.claim_next_patient_export('validation')`);
await runtime.query('COMMIT');
check(claimed.rows[0]?.id === requested.id, 'worker atomically claims the pending export');

await runtime.query('BEGIN');
await context(runtime, ids.practiceA);
const generated = await patientExportsService.generate(runtime as unknown as PoolClient, requested.id);
await runtime.query('COMMIT');
check(generated.status === 'ready' && Number(generated.size_bytes) > 0, 'worker generates a non-empty ready archive');

await runtime.query('BEGIN');
await context(runtime, ids.practiceB, ids.userB);
const hidden = await runtime.query(`SELECT count(*)::int AS count FROM luminary.patient_export_job WHERE id=$1`,[requested.id]);
await runtime.query('ROLLBACK');
check(hidden.rows[0].count === 0, 'another practice cannot see the export job');

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
const download = await patientExportsService.takeForDownload(runtime as unknown as PoolClient, actor, requested.id);
await runtime.query('COMMIT');
const archive = await consume(download.stream);
check(archive.subarray(0,2).toString() === 'PK', 'download is a ZIP archive');
check(archive.includes(Buffer.from('manifest.json')) && archive.includes(Buffer.from('Patient_Summary.pdf'))
  && archive.includes(Buffer.from('Clinical_Record.pdf')) && archive.includes(Buffer.from('Appointments.pdf')),
  'archive contains the manifest and selected generated PDFs');

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
await assert.rejects(patientExportsService.takeForDownload(runtime as unknown as PoolClient, actor, requested.id));
await runtime.query('ROLLBACK');
passed += 1; console.log(`ok ${passed} - export download is single-use`);

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
await runtime.query(`UPDATE luminary.patient_export_job SET expires_at=now()-interval '1 minute' WHERE id=$1`, [requested.id]);
await runtime.query('COMMIT');
const cleanup = await processPatientExports();
await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
const expired = await runtime.query(`SELECT status,storage_key FROM luminary.patient_export_job WHERE id=$1`, [requested.id]);
await runtime.query('ROLLBACK');
check(cleanup.expired === 1 && expired.rows[0].status === 'expired' && expired.rows[0].storage_key === null,
  'worker removes expired archive bytes and clears the storage reference');

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
const revokable = await patientExportsService.request(runtime as unknown as PoolClient, actor, ids.patientA, {
  purpose: 'TEST_REVOCATION', sections: ['summary'],
});
const revoked = await patientExportsService.revoke(runtime as unknown as PoolClient, actor, revokable.id);
await runtime.query('COMMIT');
check(revoked.status === 'revoked', 'pending export can be revoked');

await runtime.query('BEGIN');
await context(runtime, ids.practiceA, ids.userA);
await runtime.query('SAVEPOINT bad_section');
await assert.rejects(runtime.query(`INSERT INTO luminary.patient_export_job
  (practice_id,patient_id,requested_by,purpose,included_sections)
  VALUES($1,$2,$3,'TEST_BAD_SECTION',ARRAY['secrets'])`,[ids.practiceA,ids.patientA,ids.userA]));
await runtime.query('ROLLBACK TO SAVEPOINT bad_section');
await runtime.query('ROLLBACK');
passed += 1; console.log(`ok ${passed} - database rejects unknown export sections`);

await runtime.end();
await admin.end();
await closePool();
console.log(`\n${passed} patient export assertions passed`);
