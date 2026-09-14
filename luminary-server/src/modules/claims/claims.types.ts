import type { PoolClient } from 'pg';

export const CLAIM_STATUSES = [
  'DRAFT',
  'READY',
  'VALIDATION_FAILED',
  'READY_FOR_SUBMISSION',
  'SUBMITTING',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'PROCESSING',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'REJECTED',
  'QUERY',
  'REQUIRES_ACTION',
  'CANCELLED',
  'FAILED',
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type SubmissionChannel = 'NH263' | 'EMAIL_PDF' | 'MANUAL';
export type ClaimActor = { userId: string; role: string; practiceId: string };

export interface ValidationIssue {
  code: string;
  field: string;
  message: string;
}

export interface ClaimValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface CanonicalClaim {
  id: string;
  claim_number: string;
  patient_id: string;
  encounter_id: string | null;
  invoice_id: string | null;
  payer_id: string | null;
  scheme_id: string | null;
  membership_number: string | null;
  service_from_date: string | null;
  service_to_date: string | null;
  status: ClaimStatus;
  submission_channel: SubmissionChannel;
  external_reference: string | null;
  switch_reference: string | null;
  currency: string;
  total_claimed_amount: string | number;
  total_approved_amount: string | number;
  total_rejected_amount: string | number;
  member_liability: string | number;
  insurer_liability: string | number;
  submission_snapshot?: unknown;
  lines?: Record<string, unknown>[];
  diagnoses?: Record<string, unknown>[];
  attachments?: Record<string, unknown>[];
}

export interface NormalizedSubmissionResult {
  status: ClaimStatus;
  externalReference?: string | null;
  switchReference?: string | null;
  externalStatus?: string | null;
  funderStatus?: string | null;
  message?: string;
  rawPayloadRef?: string | null;
}

export interface ClaimsAdapter {
  key: SubmissionChannel;
  validateClaim(claim: CanonicalClaim): ClaimValidationResult;
  submitClaim(client: PoolClient, claim: CanonicalClaim, snapshot: unknown): Promise<NormalizedSubmissionResult>;
  getClaimStatus(client: PoolClient, claim: CanonicalClaim): Promise<NormalizedSubmissionResult>;
  mapOutboundClaim(claim: CanonicalClaim): unknown;
  mapInboundResponse(response: unknown): NormalizedSubmissionResult;
}
