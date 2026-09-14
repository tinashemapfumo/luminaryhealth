import type { PoolClient } from 'pg';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { can, type Role } from '../../platform/permissions.js';
import { adapterFor } from './adapters.js';
import { claimsRepository } from './claims.repository.js';
import { billingRepository } from '../billing/billing.repository.js';
import { assertSamePatient, requireEncounterInTenant } from '../../platform/tenant-refs.js';
import type { CanonicalClaim, ClaimValidationResult, SubmissionChannel, ValidationIssue } from './claims.types.js';

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
}

const SUBMITTABLE = new Set(['READY', 'READY_FOR_SUBMISSION', 'VALIDATION_FAILED', 'DRAFT', 'FAILED']);
const COMPLETE = new Set(['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED']);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const issue = (code: string, field: string, message: string): ValidationIssue => ({ code, field, message });

export const claimsService = {
  async list(client: PoolClient, actor: Actor, opts: {
    patientId?: string; payerId?: string; status?: string; invoiceId?: string; query?: string; limit?: number;
  }) {
    assertClaimsRead(actor);
    return claimsRepository.list(client, opts);
  },

  async get(client: PoolClient, actor: Actor, id: string) {
    assertClaimsRead(actor);
    const claim = await loadClaim(client, id, actor.userId);
    return claim;
  },

  async create(client: PoolClient, actor: Actor, input: {
    invoiceId: string; encounterId?: string | null; submissionChannel?: SubmissionChannel; notes?: string;
  }) {
    if (!can(actor.role, 'createClaims') && !can(actor.role, 'createInvoice')) {
      throw new Forbidden('Your role cannot create claims');
    }
    if (input.encounterId) {
      const invoice = await billingRepository.findInvoice(client, input.invoiceId);
      if (!invoice) throw new NotFound('Invoice not found');
      const encounter = await requireEncounterInTenant(client, input.encounterId);
      assertSamePatient(encounter.patient_id, String(invoice.patient_id), 'That encounter does not belong to this invoice patient');
    }
    const claim = await claimsRepository.createFromInvoice(client, {
      invoiceId: input.invoiceId,
      encounterId: input.encounterId ?? null,
      channel: input.submissionChannel ?? 'MANUAL',
      createdBy: actor.userId,
    });
    if (!claim) throw new BadRequest('That invoice cannot produce a claim');
    await claimsRepository.copyEncounterDiagnoses(client, claim.id);
    await claimsRepository.addEvent(client, {
      claimId: claim.id,
      type: 'claim_created',
      actorId: actor.userId,
      newStatus: claim.status,
      metadata: { invoiceId: input.invoiceId, submissionChannel: input.submissionChannel ?? 'MANUAL' },
    });
    await client.query(`SELECT luminary.write_audit('Created claim', 'claim', $1, $2, $3, 'notice')`,
      [claim.id, claim.claim_number, input.invoiceId]);
    return claimsRepository.find(client, claim.id);
  },

  async update(client: PoolClient, actor: Actor, id: string, input: {
    submissionChannel?: SubmissionChannel; notes?: string | null; membershipNumber?: string;
    memberSuffix?: string | null; relationshipToMember?: string | null;
  }) {
    if (!can(actor.role, 'editClaims') && !can(actor.role, 'submitClaims')) {
      throw new Forbidden('Your role cannot edit claims');
    }
    const claim = await loadClaim(client, id, actor.userId);
    if (!['DRAFT', 'READY', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION', 'REQUIRES_ACTION'].includes(claim.status)) {
      throw new Conflict('Submitted claims cannot be edited; create a resubmission or add an event');
    }
    const values: unknown[] = [id];
    const set: string[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      set.push(`${column} = $${values.length}`);
    };
    if (input.submissionChannel !== undefined) add('submission_channel', input.submissionChannel);
    if (input.notes !== undefined) add('notes', input.notes);
    if (input.membershipNumber !== undefined) add('membership_number', input.membershipNumber);
    if (input.memberSuffix !== undefined) add('member_suffix', input.memberSuffix);
    if (input.relationshipToMember !== undefined) add('relationship_to_member', input.relationshipToMember);
    if (set.length === 0) throw new BadRequest('Nothing to update');

    const { rows } = await client.query(
      `UPDATE luminary.claim SET ${set.join(', ')}, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!rows[0]) throw new NotFound('Claim not found');
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'claim_edited', actorId: actor.userId,
      previousStatus: claim.status, newStatus: rows[0].status, metadata: input,
    });
    await client.query(`SELECT luminary.write_audit('Edited claim', 'claim', $1, $2, NULL, 'notice')`,
      [id, claim.claim_number]);
    return claimsRepository.find(client, id);
  },

  async validate(client: PoolClient, actor: Actor, id: string, channel?: SubmissionChannel) {
    assertClaimsRead(actor);
    const claim = await loadClaim(client, id, actor.userId);
    const selected = channel ?? claim.submission_channel;
    const base = baseValidation(claim);
    const adapter = adapterFor(selected);
    const adapterResult = adapter.validateClaim({ ...claim, submission_channel: selected });
    const result: ClaimValidationResult = {
      valid: base.errors.length === 0 && adapterResult.errors.length === 0,
      errors: [...base.errors, ...adapterResult.errors],
      warnings: [...base.warnings, ...adapterResult.warnings],
    };
    const nextStatus = result.valid ? 'READY_FOR_SUBMISSION' : 'VALIDATION_FAILED';
    await claimsRepository.setStatus(client, id, nextStatus, { validation_result: result });
    await claimsRepository.addEvent(client, {
      claimId: id,
      type: result.valid ? 'validation_passed' : 'validation_failed',
      actorId: actor.userId,
      previousStatus: claim.status,
      newStatus: nextStatus,
      metadata: result,
    });
    return result;
  },

  async submit(client: PoolClient, actor: Actor, id: string, input: {
    channel?: SubmissionChannel; idempotencyKey?: string; switchRef?: string;
  }) {
    if (!can(actor.role, 'submitClaims')) throw new Forbidden('Your role cannot submit claims');
    const claim = await loadClaim(client, id, actor.userId);
    if (COMPLETE.has(claim.status)) throw new Conflict('This claim already has a final payer result');
    if (!SUBMITTABLE.has(claim.status)) throw new Conflict(`A claim in ${claim.status} cannot be submitted`);

    const channel = input.channel ?? claim.submission_channel;
    const validation = await this.validate(client, actor, id, channel);
    if (!validation.valid) return { submitted: false, validation };

    const fresh = await loadClaim(client, id, actor.userId);
    const adapter = adapterFor(channel);
    const snapshot = adapter.mapOutboundClaim({ ...fresh, submission_channel: channel });

    await claimsRepository.setStatus(client, id, 'SUBMITTING', {
      submission_channel: channel,
      submitted_by: actor.userId,
      submitted_at: new Date(),
      submission_snapshot: snapshot,
    });
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'claim_submitting', actorId: actor.userId,
      previousStatus: fresh.status, newStatus: 'SUBMITTING', metadata: { channel },
    });

    try {
      const result = await adapter.submitClaim(client, { ...fresh, submission_channel: channel }, snapshot);
      const next = await claimsRepository.setStatus(client, id, result.status, {
        submission_channel: channel,
        external_reference: result.externalReference ?? input.switchRef ?? undefined,
        switch_reference: result.switchReference ?? input.switchRef ?? undefined,
        external_status: result.externalStatus ?? undefined,
        funder_status: result.funderStatus ?? undefined,
        last_checked_at: new Date(),
        completed_at: COMPLETE.has(result.status) ? new Date() : undefined,
      });
      await claimsRepository.recordTransmission(client, {
        claimId: id, adapter: channel, direction: 'outbound', status: result.status === 'FAILED' ? 'failed' : 'succeeded',
        requestReference: input.idempotencyKey ?? id, externalReference: result.externalReference ?? input.switchRef ?? null,
        normalizedResult: result,
      });
      await claimsRepository.addEvent(client, {
        claimId: id, type: result.status === 'FAILED' ? 'transmission_failed' : 'claim_submitted',
        actorId: actor.userId, previousStatus: 'SUBMITTING', newStatus: result.status,
        externalReference: result.externalReference ?? input.switchRef ?? null, metadata: result,
      });
      await client.query(`SELECT luminary.write_audit('Submitted claim', 'claim', $1, $2, $3, 'notice')`,
        [id, fresh.claim_number, `${channel}: ${result.message ?? result.status}`]);
      return { submitted: result.status !== 'FAILED', claim: next, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Claim submission failed';
      await claimsRepository.setStatus(client, id, 'FAILED', {
        submission_channel: channel,
        last_checked_at: new Date(),
      });
      await claimsRepository.recordTransmission(client, {
        claimId: id, adapter: channel, direction: 'outbound', status: 'failed',
        requestReference: input.idempotencyKey ?? id, errorCode: 'TRANSMISSION_FAILED', errorMessage: message,
      });
      await claimsRepository.addEvent(client, {
        claimId: id, type: 'transmission_failed', actorId: actor.userId,
        previousStatus: 'SUBMITTING', newStatus: 'FAILED', metadata: { message },
      });
      return { submitted: false, error: message };
    }
  },

  async refreshStatus(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'refreshClaimStatus') && !can(actor.role, 'submitClaims')) {
      throw new Forbidden('Your role cannot refresh claim status');
    }
    const claim = await loadClaim(client, id, actor.userId);
    const authoritative = await claimsRepository.latestOutboundTransmission(client, id);
    const channel = submissionChannelFrom(authoritative?.adapter) ?? claim.submission_channel;
    assertReferenceBelongsToChannel(claim, channel);
    const adapter = adapterFor(channel);
    const result = await adapter.getClaimStatus(client, { ...claim, submission_channel: channel });
    assertReferenceBelongsToChannel(
      { ...claim, external_reference: result.externalReference ?? claim.external_reference },
      channel,
    );
    const next = await claimsRepository.setStatus(client, id, result.status, {
      submission_channel: channel,
      external_reference: result.externalReference ?? undefined,
      switch_reference: result.switchReference ?? undefined,
      external_status: result.externalStatus ?? undefined,
      funder_status: result.funderStatus ?? undefined,
      last_checked_at: new Date(),
      completed_at: COMPLETE.has(result.status) ? new Date() : undefined,
    });
    await claimsRepository.recordTransmission(client, {
      claimId: id, adapter: channel, direction: 'inbound',
      status: result.status === 'FAILED' ? 'failed' : 'received', normalizedResult: result,
    });
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'status_refreshed', actorId: actor.userId,
      previousStatus: claim.status, newStatus: result.status, metadata: { ...result, channel },
    });
    return { claim: next, result };
  },

  async recordAdjudication(client: PoolClient, actor: Actor, id: string, input: {
    result: 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'QUERY';
    lines?: Array<{ lineId: string; approvedAmount?: number; rejectedAmount?: number; memberLiability?: number; insurerLiability?: number; reasonCode?: string; reasonDescription?: string }>;
    payerReference?: string; notes?: string;
  }) {
    if (!can(actor.role, 'submitClaims')) throw new Forbidden('Your role cannot update claim outcomes');
    const claim = await loadClaim(client, id, actor.userId);
    for (const line of input.lines ?? []) {
      await client.query(
        `UPDATE luminary.claim_line
            SET approved_amount = COALESCE($2, approved_amount),
                rejected_amount = COALESCE($3, rejected_amount),
                member_liability = COALESCE($4, member_liability),
                insurer_liability = COALESCE($5, insurer_liability),
                adjudication_reason_code = COALESCE($6, adjudication_reason_code),
                adjudication_reason_description = COALESCE($7, adjudication_reason_description),
                status = CASE WHEN COALESCE($2, approved_amount) > 0 AND COALESCE($3, rejected_amount) > 0 THEN 'PARTIALLY_APPROVED'
                              WHEN COALESCE($2, approved_amount) > 0 THEN 'APPROVED'
                              ELSE 'REJECTED' END,
                updated_at = now()
          WHERE id = $1 AND claim_id = $8 AND deleted_at IS NULL`,
        [
          line.lineId, line.approvedAmount ?? null, line.rejectedAmount ?? null,
          line.memberLiability ?? null, line.insurerLiability ?? null,
          line.reasonCode ?? null, line.reasonDescription ?? null, id,
        ],
      );
    }
    const totals = await claimsRepository.recomputeTotals(client, id);
    const nextStatus = input.result === 'QUERY' ? 'QUERY' : input.result;
    await client.query(
      `INSERT INTO luminary.claim_adjudication
         (practice_id, claim_id, payer_reference, adjudicated_at, claimed_amount,
          approved_amount, rejected_amount, member_liability, insurer_liability, result, notes)
       VALUES (luminary.current_practice_id(), $1, $2, now(), $3, $4, $5, $6, $7, $8, $9)`,
      [
        id, input.payerReference ?? null, totals.total_claimed_amount, totals.total_approved_amount,
        totals.total_rejected_amount, totals.member_liability, totals.insurer_liability,
        input.result, input.notes ?? null,
      ],
    );
    await claimsRepository.setStatus(client, id, nextStatus, {
      external_reference: input.payerReference ?? undefined,
      completed_at: input.result === 'QUERY' ? undefined : new Date(),
    });
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'adjudication_recorded', actorId: actor.userId,
      previousStatus: claim.status, newStatus: nextStatus, externalReference: input.payerReference ?? null,
      metadata: input,
    });
    return claimsRepository.find(client, id);
  },

  async addAttachment(client: PoolClient, actor: Actor, id: string, input: {
    documentId: string; attachmentType: string; reason: string;
  }) {
    if (!can(actor.role, 'manageClaimAttachments') && !can(actor.role, 'writeNote')) {
      throw new Forbidden('Your role cannot attach claim documents');
    }
    if (input.reason.trim().length < 5) throw new BadRequest('Say why this document supports the claim');
    const claim = await loadClaim(client, id, actor.userId);
    const { rows: doc } = await client.query(
      `SELECT 1 FROM luminary.patient_document
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [input.documentId, claim.patient_id],
    );
    if (!doc[0]) throw new NotFound('Document not found for this patient');
    const { rows } = await client.query(
      `INSERT INTO luminary.claim_attachment
         (practice_id, claim_id, document_id, attachment_type, reason, added_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (practice_id, claim_id, document_id)
         DO UPDATE SET attachment_type = EXCLUDED.attachment_type, reason = EXCLUDED.reason, updated_at = now()
       RETURNING *`,
      [id, input.documentId, input.attachmentType, input.reason.trim(), actor.userId],
    );
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'attachment_added', actorId: actor.userId,
      previousStatus: claim.status, newStatus: claim.status, metadata: { documentId: input.documentId },
    });
    return rows[0];
  },

  async events(client: PoolClient, actor: Actor, id: string) {
    assertClaimsRead(actor);
    await loadClaim(client, id, actor.userId);
    const { rows } = await client.query(
      `SELECT e.*, u.display_name AS actor_name
         FROM luminary.claim_event e
         LEFT JOIN luminary.app_user u ON u.id = e.actor_id
        WHERE e.claim_id = $1 AND e.deleted_at IS NULL
        ORDER BY e.occurred_at DESC`,
      [id],
    );
    return rows;
  },

  async transmissions(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'viewClaimTransmissions') && !can(actor.role, 'manageIntegrations')) {
      throw new Forbidden('Your role cannot view claim transmissions');
    }
    await loadClaim(client, id, actor.userId);
    const { rows } = await client.query(
      `SELECT id, adapter, direction, attempt_number, request_reference,
              external_reference, sent_at, received_at, status, normalized_result,
              error_code, error_message, created_at
         FROM luminary.claim_transmission
        WHERE claim_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [id],
    );
    return rows;
  },

  async adjudication(client: PoolClient, actor: Actor, id: string) {
    assertClaimsRead(actor);
    await loadClaim(client, id, actor.userId);
    const { rows } = await client.query(
      `SELECT * FROM luminary.claim_adjudication
        WHERE claim_id = $1 AND deleted_at IS NULL
        ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC`,
      [id],
    );
    return rows;
  },

  async createRemittance(client: PoolClient, actor: Actor, id: string, input: {
    payerId?: string | null; remittanceReference: string; paymentDate?: string | null;
    paymentAmount: number; currency: string; reconciliationStatus?: string; details?: unknown;
  }) {
    if (!can(actor.role, 'submitClaims')) throw new Forbidden('Your role cannot record remittances');
    const claim = await loadClaim(client, id, actor.userId);
    const payerId = input.payerId ?? claim.payer_id ?? null;
    if (input.paymentAmount < 0) throw new BadRequest('Remittance amount cannot be negative');
    if (payerId && claim.payer_id && payerId !== claim.payer_id) {
      throw new BadRequest('That payer does not match the claim');
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.claim_remittance
         (practice_id, claim_id, payer_id, remittance_reference, payment_date,
          payment_amount, currency, reconciliation_status, details, created_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4::date, $5, $6, $7, $8, $9)
       ON CONFLICT (practice_id, remittance_reference)
         DO UPDATE SET remittance_reference = EXCLUDED.remittance_reference
       RETURNING *`,
      [
        id, payerId, input.remittanceReference.trim(), input.paymentDate ?? null,
        input.paymentAmount, input.currency, input.reconciliationStatus ?? 'unmatched',
        JSON.stringify(input.details ?? {}), actor.userId,
      ],
    );
    const remittance = rows[0];
    if (remittance.claim_id !== id
      || Number(remittance.payment_amount) !== input.paymentAmount
      || remittance.currency !== input.currency
      || (payerId && remittance.payer_id && remittance.payer_id !== payerId)) {
      throw new Conflict('That remittance reference was already used for a different remittance');
    }

    await claimsRepository.addEvent(client, {
      claimId: id, type: 'remittance_recorded', actorId: actor.userId,
      previousStatus: claim.status, newStatus: claim.status,
      externalReference: input.remittanceReference.trim(), metadata: { remittanceId: remittance.id, amount: input.paymentAmount },
    });
    await client.query(`SELECT luminary.write_audit('Recorded remittance', 'claim', $1, $2, $3, 'notice')`,
      [id, claim.claim_number, `${input.currency} ${input.paymentAmount} · ${input.remittanceReference.trim()}`]);
    return remittance;
  },

  async listRemittances(client: PoolClient, actor: Actor, id: string) {
    assertClaimsRead(actor);
    await loadClaim(client, id, actor.userId);
    const { rows } = await client.query(
      `SELECT r.*, p.name AS payer_name
         FROM luminary.claim_remittance r
         LEFT JOIN luminary.payer p ON p.id = r.payer_id
        WHERE r.claim_id = $1 AND r.deleted_at IS NULL
        ORDER BY r.received_at DESC, r.created_at DESC`,
      [id],
    );
    return rows;
  },

  async getRemittance(client: PoolClient, actor: Actor, id: string, remittanceId: string) {
    assertClaimsRead(actor);
    await loadClaim(client, id, actor.userId);
    const { rows } = await client.query(
      `SELECT r.*, p.name AS payer_name
         FROM luminary.claim_remittance r
         LEFT JOIN luminary.payer p ON p.id = r.payer_id
        WHERE r.id = $1 AND r.claim_id = $2 AND r.deleted_at IS NULL`,
      [remittanceId, id],
    );
    if (!rows[0]) throw new NotFound('Remittance not found');
    return rows[0];
  },

  async recordDenialDisposition(client: PoolClient, actor: Actor, id: string, input: {
    disposition: 'PATIENT_RESPONSIBILITY' | 'WRITE_OFF' | 'APPEAL' | 'RESUBMIT';
    amount: number; reason: string; claimLineId?: string | null;
  }) {
    if (!can(actor.role, 'adjustBalance')) throw new Forbidden('Your role cannot resolve denied amounts');
    if (input.amount <= 0) throw new BadRequest('Disposition amount must be greater than zero');
    if (input.reason.trim().length < 10) throw new BadRequest('Give a fuller reason for the denial disposition');

    const claim = await loadClaim(client, id, actor.userId);
    if (!claim.invoice_id) throw new BadRequest('Denied amounts can only be resolved for invoice-backed claims');
    if (input.claimLineId && !(claim.lines ?? []).some((line) => line.id === input.claimLineId)) {
      throw new BadRequest('That claim line does not belong to this claim');
    }
    const receivables = await billingRepository.receivableSummary(client, claim.invoice_id);
    const unresolved = round2(Number(receivables.unresolved_denied_amount));
    if (input.amount > unresolved) {
      throw new Conflict(`That is more than the ${claim.currency} ${unresolved.toFixed(2)} unresolved denial.`);
    }

    let adjustmentId: string | null = null;
    if (input.disposition === 'WRITE_OFF') {
      const adjustment = await billingRepository.recordAdjustment(client, {
        invoiceId: claim.invoice_id,
        kind: 'write_off',
        amount: input.amount,
        currency: claim.currency,
        reason: input.reason,
        decidedBy: actor.userId,
        responsibilityBucket: 'denied',
        claimId: id,
        claimLineId: input.claimLineId ?? null,
      });
      adjustmentId = adjustment.id;
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.claim_denial_disposition
         (practice_id, claim_id, claim_line_id, invoice_id, disposition, amount,
          currency, reason, adjustment_id, decided_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id, input.claimLineId ?? null, claim.invoice_id, input.disposition, input.amount,
        claim.currency, input.reason.trim(), adjustmentId, actor.userId,
      ],
    );

    await billingRepository.settleInvoice(client, claim.invoice_id);
    await claimsRepository.addEvent(client, {
      claimId: id, type: 'denial_disposition_recorded', actorId: actor.userId,
      previousStatus: claim.status, newStatus: claim.status,
      metadata: { disposition: input.disposition, amount: input.amount, claimLineId: input.claimLineId ?? null, adjustmentId },
    });
    await client.query(`SELECT luminary.write_audit('Resolved denied claim amount', 'claim', $1, $2, $3, 'alert')`,
      [id, claim.claim_number, `${claim.currency} ${input.amount} ${input.disposition}: ${input.reason.trim()}`]);
    return rows[0];
  },

  async configuration(client: PoolClient, actor: Actor) {
    if (!can(actor.role, 'submitClaims') && !can(actor.role, 'manageIntegrations')) {
      throw new Forbidden('Your role cannot view claims configuration');
    }
    const { rows } = await client.query(
      `SELECT nh263_enabled, nh263_environment, nh263_provider_number,
              nh263_organisation_identifier, nh263_endpoint, claims_status_poll_minutes,
              claims_capabilities, claims_last_success_at, claims_integration_health
         FROM luminary.practice_settings
        WHERE practice_id = luminary.current_practice_id()`,
    );
    return {
      ...rows[0],
      adapters: [
        { key: 'MANUAL', ready: true },
        { key: 'EMAIL_PDF', ready: true, note: 'PDF/email generation plugs into the canonical snapshot' },
        { key: 'NH263', ready: false, note: 'Pending official NH263 technical specification and credentials' },
      ],
    };
  },
};

async function loadClaim(client: PoolClient, id: string, actorId?: string): Promise<CanonicalClaim> {
  const claim = await claimsRepository.find(client, id);
  if (!claim) throw new NotFound('Claim not found');
  if (claim.invoice_id) await claimsRepository.copyInvoiceLines(client, id, actorId);
  if (claim.encounter_id) await claimsRepository.copyEncounterDiagnoses(client, id);
  return (await claimsRepository.find(client, id))!;
}

function assertClaimsRead(actor: Actor): void {
  if (!can(actor.role, 'readClaims') && !can(actor.role, 'submitClaims') && !can(actor.role, 'captureBiometric')) {
    throw new Forbidden('Your role cannot read claims');
  }
}

function baseValidation(claim: CanonicalClaim): ClaimValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!claim.patient_id) errors.push(issue('PATIENT_REQUIRED', 'patientId', 'A claim must name a patient'));
  if (!claim.membership_number) errors.push(issue('MEMBERSHIP_REQUIRED', 'membershipNumber', 'Medical aid membership number is required'));
  if (!claim.payer_id && !claim.scheme_id) errors.push(issue('PAYER_REQUIRED', 'payerId', 'A funder or scheme must be selected'));
  if (!claim.service_from_date) errors.push(issue('SERVICE_DATE_REQUIRED', 'serviceFromDate', 'Treatment date is required'));
  if (!claim.lines?.length) errors.push(issue('CLAIM_LINES_REQUIRED', 'lines', 'At least one claim line is required'));
  for (const [index, line] of (claim.lines ?? []).entries()) {
    if (!line.tariff_code) errors.push(issue('TARIFF_REQUIRED', `lines.${index}.tariffCode`, 'Each claim line needs a tariff code'));
    if (Number(line.claimed_amount ?? 0) <= 0) errors.push(issue('AMOUNT_REQUIRED', `lines.${index}.claimedAmount`, 'Claimed amount must be greater than zero'));
    if (!line.practitioner_id) warnings.push(issue('PRACTITIONER_MISSING', `lines.${index}.practitioner`, 'Treating practitioner is not recorded'));
  }
  if (!claim.diagnoses?.some((d) => d.kind === 'primary')) {
    errors.push(issue('PRIMARY_DIAGNOSIS_REQUIRED', 'diagnoses', 'At least one primary ICD-10 diagnosis is required'));
  }
  return { valid: errors.length === 0, errors, warnings };
}

function submissionChannelFrom(value: unknown): SubmissionChannel | null {
  return value === 'NH263' || value === 'EMAIL_PDF' || value === 'MANUAL' ? value : null;
}

function assertReferenceBelongsToChannel(claim: Pick<CanonicalClaim, 'external_reference' | 'switch_reference'>, channel: SubmissionChannel) {
  const external = claim.external_reference ?? '';
  const switchRef = claim.switch_reference ?? '';
  if (external.startsWith('MANUAL-') && channel !== 'MANUAL') {
    throw new Conflict('Manual claim reference cannot be refreshed through another adapter');
  }
  if (external.startsWith('EMAIL-') && channel !== 'EMAIL_PDF') {
    throw new Conflict('Email claim reference cannot be refreshed through another adapter');
  }
  if (switchRef && channel !== 'NH263') {
    throw new Conflict('Switch claim reference must be refreshed through NH263');
  }
}
