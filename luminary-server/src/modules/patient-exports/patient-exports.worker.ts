import { config } from '../../platform/config.js';
import { withTenant, withoutTenant } from '../../platform/db.js';
import { allocatePatientExportFile, removePatientFile } from '../../platform/file-storage.js';
import { patientExportsService } from './patient-exports.service.js';

const INTERVAL_MS = 5_000;

export async function processPatientExports(): Promise<{ generated: number; failed: number; expired: number }> {
  let generated = 0;
  let failed = 0;
  let expired = 0;
  const claimed = await withoutTenant(async (client) =>
    (await client.query<{ id: string; practice_id: string; patient_id: string }>(
      `SELECT * FROM luminary.claim_next_patient_export($1)`, [config.nodeId],
    )).rows[0] ?? null);

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
