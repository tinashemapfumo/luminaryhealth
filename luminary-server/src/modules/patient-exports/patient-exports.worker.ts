import { config } from '../../platform/config.js';
import { withTenant, withoutTenant } from '../../platform/db.js';
import { allocatePatientExportFile, removePatientFile } from '../../platform/file-storage.js';
import { patientExportsService } from './patient-exports.service.js';

const INTERVAL_MS = 5_000;

export async function processPatientExports(): Promise<{ generated: number; failed: number; expired: number }> {
  let generated = 0;
  let failed = 0;
  let expired = 0;
  // Discovery only crosses the tenant boundary to ask "which row, in which
  // practice" — never to write. The claim itself runs inside a normal
  // withTenant call below, so current_practice_id() is genuinely set and the
  // row survives the touch_and_log trigger's own RLS-protected insert into
  // sync_change, the same way the messaging dispatcher and sync worker find
  // cross-tenant work without ever writing outside a real tenant context.
  const candidate = await withoutTenant(async (client) =>
    (await client.query<{ id: string; practice_id: string }>(
      `SELECT * FROM luminary.next_pending_patient_export()`,
    )).rows[0] ?? null);

  const claimed = candidate ? await withTenant(
    { practiceId: candidate.practice_id, userId: null },
    async (client) => {
      const { rows } = await client.query<{ id: string; patient_id: string }>(
        `UPDATE luminary.patient_export_job
            SET status = 'processing', started_at = now(), updated_at = now(), origin_node = $2
          WHERE id = $1 AND status = 'pending'
          RETURNING id, patient_id`,
        [candidate.id, config.nodeId],
      );
      return rows[0] ? { ...rows[0], practice_id: candidate.practice_id } : null;
    },
  ) : null;

  if (claimed) {
    try {
      await withTenant({ practiceId: claimed.practice_id, userId: null }, async (client) => {
        await patientExportsService.generate(client, claimed.id);
      });
      generated = 1;
    } catch (error) {
      failed = 1;
      const code = error instanceof Error ? error.name.slice(0, 80) : 'ExportError';
      try {
        const partial = await allocatePatientExportFile({
          practiceId: claimed.practice_id, patientId: claimed.patient_id, exportId: claimed.id,
        });
        await removePatientFile(partial.storageKey);
      } catch (cleanupError) {
        if ((cleanupError as { code?: string }).code !== 'ENOENT') {
          console.error('Failed to remove partial patient export', { exportId: claimed.id });
        }
      }
      await withTenant({ practiceId: claimed.practice_id, userId: null }, async (client) => {
        await client.query(
          `UPDATE luminary.patient_export_job SET status='failed',failure_code=$2,updated_at=now()
            WHERE id=$1 AND status='processing'`, [claimed.id, code],
        );
      });
    }
  }

  const expiredFiles = await withoutTenant(async (client) =>
    (await client.query<{ id: string; practice_id: string; storage_key: string; next_status: string }>(
      `SELECT * FROM luminary.patient_export_files_to_remove()`,
    )).rows);
  for (const item of expiredFiles) {
    try {
      await removePatientFile(item.storage_key);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') continue;
    }
    await withTenant({ practiceId: item.practice_id, userId: null }, async (client) => {
      await client.query(
        `UPDATE luminary.patient_export_job SET status=$2,storage_key=NULL,updated_at=now()
          WHERE id=$1 AND storage_key IS NOT NULL`, [item.id, item.next_status],
      );
    });
    expired += 1;
  }
  return { generated, failed, expired };
}

export function startPatientExportWorker(
  log: (result: { generated: number; failed: number; expired: number }) => void,
  onError: (error: unknown) => void,
) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void processPatientExports().then((result) => {
      if (result.generated || result.failed || result.expired) log(result);
    }).catch(onError).finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
