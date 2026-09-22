import { withTenant, withoutTenant } from '../../platform/db.js';
import { followupService } from './followup.service.js';
import { runPracticeBatches, type ReconciliationResult } from './followup.reconciliation.js';

const INTERVAL_MS = 5 * 60 * 1000;

export async function reconcileFollowups(): Promise<ReconciliationResult> {
  const practices = await withoutTenant(async (client) => {
    const { rows } = await client.query<{ practice_id: string }>(
      `SELECT practice_id FROM luminary.practices_with_missing_followups()`,
    );
    return rows;
  });
  return runPracticeBatches(practices, async (practiceId) => {
    let created = 0;
    await withTenant({ practiceId, userId: null }, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT e.id
           FROM luminary.encounter e
           JOIN luminary.appointment a ON a.id = e.appointment_id
          WHERE e.follow_up_required = true
            AND e.status IN ('signed', 'amended') AND a.status = 'completed'
            AND e.deleted_at IS NULL AND a.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM luminary.patient_followup f
               WHERE f.encounter_id = e.id AND f.deleted_at IS NULL
                 AND f.status NOT IN ('completed', 'cancelled', 'failed', 'expired')
            )
          ORDER BY e.signed_at NULLS LAST
          LIMIT 100`,
        );
        for (const encounter of rows) {
          const result = await followupService.ensureIfEligible(client, encounter.id);
          if (result && !result.replayed) created += 1;
        }
      });
    return created;
  });
}

export function startFollowupReconciler(
  log: (result: ReconciliationResult) => void,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void reconcileFollowups()
      .then((result) => {
        if (result.created > 0 || result.failures.length > 0) log(result);
      })
      .catch(onError)
      .finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
