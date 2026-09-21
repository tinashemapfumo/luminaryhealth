import { z } from 'zod';
import { COMPARISON_MODES, REPORTING_PERIODS } from './reporting-period.js';

export const reportingRequestSchema = z.object({
  period: z.enum(REPORTING_PERIODS).default('last_30_days'),
  compare: z.enum(COMPARISON_MODES).default('previous_period'),
}).strict();
