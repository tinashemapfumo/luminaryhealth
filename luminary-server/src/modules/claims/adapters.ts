import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CanonicalClaim,
  ClaimValidationResult,
  ClaimsAdapter,
  NormalizedSubmissionResult,
  SubmissionChannel,
} from './claims.types.js';

const ok = (): ClaimValidationResult => ({ valid: true, errors: [], warnings: [] });
const pending = (message: string): ClaimValidationResult => ({
  valid: false,
  errors: [{ code: 'ADAPTER_PENDING_SPEC', field: 'submissionChannel', message }],
  warnings: [],
});

export class ManualClaimAdapter implements ClaimsAdapter {
  key: SubmissionChannel = 'MANUAL';

  validateClaim(): ClaimValidationResult {
    return ok();
  }

  async submitClaim(_client: PoolClient, claim: CanonicalClaim): Promise<NormalizedSubmissionResult> {
    return {
      status: 'ACKNOWLEDGED',
      externalReference: claim.external_reference ?? `MANUAL-${claim.claim_number}`,
      message: 'Marked for manual claim handling from the canonical Luminary claim.',
    };
  }

  async getClaimStatus(_client: PoolClient, claim: CanonicalClaim): Promise<NormalizedSubmissionResult> {
    return {
      status: claim.status,
      externalReference: claim.external_reference,
      switchReference: claim.switch_reference,
      message: 'Manual claims are updated by staff when the payer responds.',
    };
  }

  mapOutboundClaim(claim: CanonicalClaim): unknown {
    return { channel: 'manual', claim };
  }

  mapInboundResponse(response: unknown): NormalizedSubmissionResult {
    return { status: 'PROCESSING', message: 'Manual response recorded', externalStatus: JSON.stringify(response) };
  }
}

export class EmailPdfClaimAdapter extends ManualClaimAdapter {
  override key: SubmissionChannel = 'EMAIL_PDF';

  override async submitClaim(_client: PoolClient, claim: CanonicalClaim): Promise<NormalizedSubmissionResult> {
    return {
      status: 'ACKNOWLEDGED',
      externalReference: claim.external_reference ?? `EMAIL-${claim.claim_number}`,
      message: 'Queued for PDF/email submission. Document generation plugs into this adapter.',
    };
  }

  override mapOutboundClaim(claim: CanonicalClaim): unknown {
    return { channel: 'email_pdf', claim };
  }
}

export class NH263Adapter implements ClaimsAdapter {
  key: SubmissionChannel = 'NH263';

  validateClaim(): ClaimValidationResult {
    return pending('NH263 validation is waiting on the official payload, authentication, endpoint, and reason-code specification.');
  }

  async submitClaim(): Promise<NormalizedSubmissionResult> {
    return {
      status: 'FAILED',
      message: 'NH263 submission is not configured. Supply the official NH263 technical specification before enabling production calls.',
    };
  }

  async getClaimStatus(): Promise<NormalizedSubmissionResult> {
    return {
      status: 'FAILED',
      message: 'NH263 status refresh is pending the official status endpoint and authentication specification.',
    };
  }

  mapOutboundClaim(claim: CanonicalClaim): unknown {
    return {
      adapter: 'NH263',
      documentation: 'pending NH263/New Health 263 technical specification',
      idempotencyReference: claim.id,
      claim,
    };
  }

  mapInboundResponse(response: unknown): NormalizedSubmissionResult {
    return {
      status: 'PROCESSING',
      switchReference: `NH263-PENDING-MAPPER-${randomUUID()}`,
      message: 'Inbound NH263 response mapper placeholder. Replace when response schema is supplied.',
      externalStatus: JSON.stringify(response),
    };
  }
}

export function adapterFor(channel: SubmissionChannel): ClaimsAdapter {
  if (channel === 'NH263') return new NH263Adapter();
  if (channel === 'EMAIL_PDF') return new EmailPdfClaimAdapter();
  return new ManualClaimAdapter();
}
