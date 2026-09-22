export interface ReconciliationResult {
  practices: number;
  created: number;
  failures: Array<{ practiceId: string; error: string }>;
}

export async function runPracticeBatches(
  practices: Array<{ practice_id: string }>,
  runPractice: (practiceId: string) => Promise<number>,
): Promise<ReconciliationResult> {
  let created = 0;
  const failures: ReconciliationResult['failures'] = [];
  for (const practice of practices) {
    try {
      created += await runPractice(practice.practice_id);
    } catch (error) {
      failures.push({
        practiceId: practice.practice_id,
        error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown reconciliation error',
      });
    }
  }
  return { practices: practices.length, created, failures };
}
