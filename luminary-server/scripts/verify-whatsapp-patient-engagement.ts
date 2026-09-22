import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, types, type PoolClient } from 'pg';
import { agentService } from '../src/modules/agent/agent.service.js';
import { followupService } from '../src/modules/agent/followup.service.js';
import { patientMatchingService } from '../src/modules/agent/patient-matching.service.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';

const adminUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL or MIGRATION_DATABASE_URL is required');
types.setTypeParser(1082, (value) => value);

let passed = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  passed += 1;
  console.log(`ok ${passed} - ${message}`);
};

const expectPgError = async (client: Client, sql: string, values: unknown[], message: string) => {
  await client.query('SAVEPOINT expected_error');
  try {
    await client.query(sql, values);
    assert.fail(message);
  } catch (error) {
    assert.notEqual((error as Error).name, 'AssertionError', message);
    passed += 1;
    console.log(`ok ${passed} - ${message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_error');
    await client.query('RELEASE SAVEPOINT expected_error');
  }
};

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luminary_validation') THEN
    CREATE ROLE luminary_validation LOGIN PASSWORD 'validation_only';
  END IF;
END $$`);
await admin.query('GRANT luminary_app TO luminary_validation');

const ids = Object.fromEntries([
  'practiceA', 'practiceB', 'userA', 'userB', 'patientA', 'patientB',
  'credentialA', 'credentialA2', 'credentialB', 'conversationA', 'conversationA2',
  'conversationSms', 'conversationB', 'conversationReg1', 'conversationReg2',
  'appointmentA', 'appointmentNoIntent',
  'appointmentB', 'encounterA', 'encounterNoIntent', 'encounterB', 'followupA',
  'followupB', 'consentA', 'consentB', 'messageA', 'messageB', 'inboundA', 'inboundB',
].map((name) => [name, randomUUID()])) as Record<string, string>;
const suffix = randomUUID().slice(0, 8);

await admin.query('BEGIN');
try {
  await admin.query(
    `INSERT INTO luminary.practice (id, name, short_name) VALUES ($1,$2,$3),($4,$5,$6)`,
    [ids.practiceA, `Validation A ${suffix}`, `VA${suffix}`, ids.practiceB, `Validation B ${suffix}`, `VB${suffix}`],
  );
  for (const [practice, user, patient, credential, key] of [
    [ids.practiceA, ids.userA, ids.patientA, ids.credentialA, `cred-a-${suffix}`],
    [ids.practiceB, ids.userB, ids.patientB, ids.credentialB, `cred-b-${suffix}`],
  ]) {
    await admin.query(`SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id',$2,true), set_config('luminary.node','validation',true)`, [practice, user]);
    await admin.query(`INSERT INTO luminary.app_user (id,practice_id,email,full_name,display_name,role,is_provider) VALUES ($1,$2,$3,$4,$4,'doctor',true)`, [user, practice, `${key}@test.invalid`, `Doctor ${key}`]);
    await admin.query(`INSERT INTO luminary.patient (id,practice_id,reference,full_name,date_of_birth,national_id,phone) VALUES ($1,$2,$3,$4,'1990-01-02',$5,$6)`, [patient, practice, `P-${key}`, `Patient ${key}`, `ID-${key}`, `26377${suffix.replace(/\D/g, '').padEnd(7, '1')}`]);
    await admin.query(`INSERT INTO luminary.integration_credential (id,practice_id,name,key_id,secret_hash,scopes) VALUES ($1,$2,$3,$4,'test-hash',ARRAY['agent:intake','agent:followup'])`, [credential, practice, key, key]);
  }
  await admin.query(`SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id',$2,true)`, [ids.practiceA, ids.userA]);
  await admin.query(`INSERT INTO luminary.integration_credential (id,practice_id,name,key_id,secret_hash,scopes) VALUES ($1,$2,'second credential',$3,'test-hash',ARRAY['agent:intake'])`, [ids.credentialA2, ids.practiceA, `cred-a2-${suffix}`]);
  for (const [id, credential, channel] of [
    [ids.conversationA, ids.credentialA, 'whatsapp'],
    [ids.conversationA2, ids.credentialA2, 'whatsapp'],
    [ids.conversationSms, ids.credentialA, 'sms'],
  ]) await admin.query(`INSERT INTO luminary.agent_conversation (id,practice_id,credential_id,channel,from_number,patient_id) VALUES ($1,$2,$3,$4,'263771234567',$5)`, [id, ids.practiceA, credential, channel, ids.patientA]);
  const registrationPhone = `26378${suffix.replace(/\D/g, '').padEnd(7, '2')}`;
  await admin.query(
    `INSERT INTO luminary.agent_conversation (id,practice_id,credential_id,channel,from_number)
     VALUES ($1,$3,$4,'whatsapp',$5),($2,$3,$4,'whatsapp',$5)`,
    [ids.conversationReg1, ids.conversationReg2, ids.practiceA, ids.credentialA, registrationPhone],
  );
  await admin.query(`INSERT INTO luminary.appointment (id,practice_id,patient_id,provider_id,starts_at,status) VALUES ($1,$2,$3,$4,now()-interval '1 hour','completed'),($5,$2,$3,$4,now()-interval '2 hour','completed')`, [ids.appointmentA, ids.practiceA, ids.patientA, ids.userA, ids.appointmentNoIntent]);
  await admin.query(`INSERT INTO luminary.encounter (id,practice_id,patient_id,appointment_id,author_id,status,signed_by,signed_at,follow_up_required) VALUES ($1,$2,$3,$4,$5,'signed',$5,now(),true),($6,$2,$3,$7,$5,'signed',$5,now(),false)`, [ids.encounterA, ids.practiceA, ids.patientA, ids.appointmentA, ids.userA, ids.encounterNoIntent, ids.appointmentNoIntent]);
  await admin.query(`INSERT INTO luminary.patient_consent_event (id,practice_id,patient_id,conversation_id,credential_id,consent_type,accepted,source,policy_version,occurred_at) VALUES ($1,$2,$3,$4,$5,'treatment',true,'whatsapp','TEST_PATIENT_REGISTRATION_V1',now())`, [ids.consentA, ids.practiceA, ids.patientA, ids.conversationA, ids.credentialA]);
  await admin.query(`INSERT INTO luminary.message (id,practice_id,patient_id,channel,body,recipient,sent_via_credential,conversation_id,idempotency_key) VALUES ($1,$2,$3,'whatsapp','test','263771234567',$4,$5,'outbound-key')`, [ids.messageA, ids.practiceA, ids.patientA, ids.credentialA, ids.conversationA]);
  await admin.query(`INSERT INTO luminary.inbound_message (id,practice_id,patient_id,channel,from_number,body,provider_ref,conversation_id) VALUES ($1,$2,$3,'whatsapp','263771234567','test',$4,$5)`, [ids.inboundA, ids.practiceA, ids.patientA, `provider-${suffix}`, ids.conversationA]);
  await admin.query(`SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id',$2,true)`, [ids.practiceB, ids.userB]);
  await admin.query(`INSERT INTO luminary.agent_conversation (id,practice_id,credential_id,channel,from_number,patient_id) VALUES ($1,$2,$3,'whatsapp','263771234567',$4)`, [ids.conversationB, ids.practiceB, ids.credentialB, ids.patientB]);
  await admin.query(`INSERT INTO luminary.appointment (id,practice_id,patient_id,provider_id,starts_at,status) VALUES ($1,$2,$3,$4,now()-interval '1 hour','completed')`, [ids.appointmentB, ids.practiceB, ids.patientB, ids.userB]);
  await admin.query(`INSERT INTO luminary.encounter (id,practice_id,patient_id,appointment_id,author_id,status,signed_by,signed_at,follow_up_required) VALUES ($1,$2,$3,$4,$5,'signed',$5,now(),true)`, [ids.encounterB, ids.practiceB, ids.patientB, ids.appointmentB, ids.userB]);
  await admin.query(`INSERT INTO luminary.patient_followup (id,practice_id,patient_id,encounter_id,appointment_id) VALUES ($1,$2,$3,$4,$5)`, [ids.followupB, ids.practiceB, ids.patientB, ids.encounterB, ids.appointmentB]);
  await admin.query(`INSERT INTO luminary.patient_consent_event (id,practice_id,patient_id,conversation_id,credential_id,consent_type,accepted,source,policy_version,occurred_at) VALUES ($1,$2,$3,$4,$5,'communications',false,'whatsapp','TEST_PATIENT_REGISTRATION_V1',now())`, [ids.consentB, ids.practiceB, ids.patientB, ids.conversationB, ids.credentialB]);
  await admin.query(`INSERT INTO luminary.message (id,practice_id,patient_id,channel,body,sent_via_credential,conversation_id,idempotency_key) VALUES ($1,$2,$3,'whatsapp','test',$4,$5,'outbound-key')`, [ids.messageB, ids.practiceB, ids.patientB, ids.credentialB, ids.conversationB]);
  await admin.query(`INSERT INTO luminary.inbound_message (id,practice_id,patient_id,channel,from_number,body,provider_ref,conversation_id) VALUES ($1,$2,$3,'whatsapp','263771234567','test',$4,$5)`, [ids.inboundB, ids.practiceB, ids.patientB, `provider-b-${suffix}`, ids.conversationB]);
  await admin.query('COMMIT');
} catch (error) {
  await admin.query('ROLLBACK');
  throw error;
}

const runtimeUrl = new URL(adminUrl);
runtimeUrl.username = 'luminary_validation';
runtimeUrl.password = 'validation_only';
const runtime = new Client({ connectionString: runtimeUrl.toString() });
await runtime.connect();
const role = await runtime.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
check(!role.rows[0].rolsuper && !role.rows[0].rolbypassrls, 'runtime validation role cannot bypass RLS');

await runtime.query('BEGIN');
try {
  await runtime.query(`SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id','',true), set_config('luminary.node','validation',true), set_config('luminary.integration_credential_id',$2,true)`, [ids.practiceA, ids.credentialA]);
  const foreignRows: Array<[string, string]> = [
    ['patient', ids.patientB], ['encounter', ids.encounterB], ['appointment', ids.appointmentB],
    ['patient_followup', ids.followupB], ['patient_consent_event', ids.consentB],
    ['agent_conversation', ids.conversationB], ['inbound_message', ids.inboundB], ['message', ids.messageB],
  ];
  for (const [table, id] of foreignRows) {
    const visible = await runtime.query(`SELECT count(*)::int AS count FROM luminary.${table} WHERE id = $1`, [id]);
    check(visible.rows[0].count === 0, `${table} from another practice is not visible`);
  }
  const blockedUpdate = await runtime.query(`UPDATE luminary.patient SET full_name='blocked' WHERE id=$1`, [ids.patientB]);
  check(blockedUpdate.rowCount === 0, 'cross-practice patient mutation affects zero rows');
  const conversations = await runtime.query(`SELECT id FROM luminary.agent_conversation WHERE from_number='263771234567' ORDER BY id`);
  check(conversations.rowCount === 3, 'same phone remains isolated by channel and credential');
  await assert.rejects(agentService.requireConversation(runtime as unknown as PoolClient, ids.conversationA2, ids.credentialA));
  passed += 1; console.log(`ok ${passed} - credential A cannot use credential A2 conversation`);

  const noIntent = await followupService.ensureIfEligible(runtime as unknown as PoolClient, ids.encounterNoIntent);
  check(noIntent === null, 'completed signed encounter without explicit intent creates no follow-up');
  const created = await followupService.ensureIfEligible(runtime as unknown as PoolClient, ids.encounterA);
  check(created?.replayed === false, 'explicit intent creates an eligible follow-up');
  ids.followupA = created!.followup.id;
  const repeated = await followupService.ensureIfEligible(runtime as unknown as PoolClient, ids.encounterA);
  check(repeated?.replayed === true && repeated.followup.id === ids.followupA, 'repeated ensure is idempotent');
  await expectPgError(runtime, `INSERT INTO luminary.patient_followup (practice_id,patient_id,encounter_id,appointment_id) VALUES ($1,$2,$3,$4)`, [ids.practiceA, ids.patientA, ids.encounterA, ids.appointmentA], 'active follow-up partial unique index prevents duplicates');
  await expectPgError(runtime, `UPDATE luminary.patient_consent_event SET accepted=false WHERE id=$1`, [ids.consentA], 'consent evidence is append-only on update');
  await expectPgError(runtime, `DELETE FROM luminary.patient_consent_event WHERE id=$1`, [ids.consentA], 'consent evidence is append-only on delete');
  await expectPgError(runtime, `INSERT INTO luminary.message (practice_id,patient_id,channel,body,sent_via_credential,idempotency_key) VALUES ($1,$2,'whatsapp','duplicate',$3,'outbound-key')`, [ids.practiceA, ids.patientA, ids.credentialA], 'outbound message unique index prevents duplicate enqueue');
  const conversation = await agentService.requireConversation(
    runtime as unknown as PoolClient, ids.conversationA, ids.credentialA,
  );
  const escalated = await followupService.recordResponse(
    runtime as unknown as PoolClient, ids.followupA, conversation,
    {
      responseKey: `uncertain-${suffix}`, summary: 'Uncertain test response',
      patientResponse: { symptoms: 'unknown' }, symptomStatus: 'unknown',
      medicationAdherence: 'as_directed', requiresClinicalReview: false,
    },
  );
  check(escalated.followup.status === 'escalated', 'uncertain response escalates for clinical review');
  await assert.rejects(followupService.complete(runtime as unknown as PoolClient, ids.followupA, conversation));
  passed += 1; console.log(`ok ${passed} - agent cannot complete an escalated follow-up`);
  const underReview = await followupService.review(runtime as unknown as PoolClient, ids.followupA, ids.userA, false);
  check(underReview.status === 'under_review', 'authorized staff can place escalation under review');
  const reviewedComplete = await followupService.review(runtime as unknown as PoolClient, ids.followupA, ids.userA, true);
  check(reviewedComplete.status === 'completed' && !reviewedComplete.requires_clinical_review, 'staff can complete after review');
  const replayedMessage = await messagingService.queueFromIntegration(runtime as unknown as PoolClient, {
    patientId: ids.patientA, to: '263771234567', channel: 'whatsapp', body: 'test',
    credentialId: ids.credentialA, conversationId: ids.conversationA, idempotencyKey: 'outbound-key',
  });
  check(replayedMessage.duplicate === true && replayedMessage.id === ids.messageA, 'identical outbound retry replays the original message');
  await assert.rejects(
    messagingService.queueFromIntegration(runtime as unknown as PoolClient, {
      patientId: ids.patientA, to: '263771234567', channel: 'whatsapp', body: 'changed',
      credentialId: ids.credentialA, conversationId: ids.conversationA, idempotencyKey: 'outbound-key',
    }),
  );
  passed += 1; console.log(`ok ${passed} - changed outbound payload with the same key conflicts`);
  const legacyFirst = await messagingService.queueFromIntegration(runtime as unknown as PoolClient, {
    patientId: ids.patientA, to: '263771234567', channel: 'whatsapp', body: 'legacy unkeyed',
    credentialId: ids.credentialA, conversationId: ids.conversationA,
  });
  const legacySecond = await messagingService.queueFromIntegration(runtime as unknown as PoolClient, {
    patientId: ids.patientA, to: '263771234567', channel: 'whatsapp', body: 'legacy unkeyed',
    credentialId: ids.credentialA, conversationId: ids.conversationA,
  });
  check(legacyFirst.id !== legacySecond.id && !legacyFirst.duplicate && !legacySecond.duplicate,
    'legacy unkeyed outbound calls remain compatible and are not presented as deduplicated');
  const match = await patientMatchingService.match(runtime as unknown as PoolClient, { fullName: `Patient cred-a-${suffix}`, dateOfBirth: '1990-01-02', phone: `26377${suffix.replace(/\D/g, '').padEnd(7, '1')}`, nationalId: `ID-cred-a-${suffix}` });
  check(match.result === 'matched' && match.patientId === ids.patientA, 'exact national ID plus demographics matches within tenant');
  await runtime.query('ROLLBACK');
} catch (error) {
  await runtime.query('ROLLBACK');
  throw error;
}

const registrationPhone = `26378${suffix.replace(/\D/g, '').padEnd(7, '2')}`;
const registerOnce = async (conversationId: string) => {
  const client = new Client({ connectionString: runtimeUrl.toString() });
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id','',true),
              set_config('luminary.node','validation',true),
              set_config('luminary.integration_credential_id',$2,true)`,
      [ids.practiceA, ids.credentialA],
    );
    const conversation = await agentService.requireConversation(
      client as unknown as PoolClient, conversationId, ids.credentialA,
    );
    const patient = await agentService.registerPatient(
      client as unknown as PoolClient, conversation, ids.credentialA,
      {
        fullName: `Concurrent Patient ${suffix}`, dateOfBirth: '1992-03-04', sex: 'female',
        phone: registrationPhone, nationalId: `CONCURRENT-${suffix}`,
        addressCity: 'Validation', emergencyName: 'Test Contact', emergencyPhone: '263770000000',
        consentTreatment: true, consentCommunications: true, consentDataProcessing: true,
        consentOccurredAt: new Date().toISOString(), consentPolicyVersion: 'TEST_PATIENT_REGISTRATION_V1',
      },
    );
    await client.query('COMMIT');
    return patient.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
};

const concurrent = await Promise.allSettled([
  registerOnce(ids.conversationReg1), registerOnce(ids.conversationReg2),
]);
check(concurrent.filter((result) => result.status === 'fulfilled').length === 1,
  'concurrent duplicate registration permits exactly one transaction');
await runtime.query('BEGIN');
await runtime.query(`SELECT set_config('luminary.practice_id',$1,true), set_config('luminary.user_id','',true)`, [ids.practiceA]);
const concurrentCount = await runtime.query(
  `SELECT count(*)::int AS count FROM luminary.patient
    WHERE lower(regexp_replace(national_id, '[\s-]', '', 'g')) = $1`,
  [`concurrent${suffix}`.toLowerCase()],
);
check(concurrentCount.rows[0].count === 1, 'concurrent registration leaves one patient record');
await runtime.query('ROLLBACK');

await runtime.end();
await admin.end();
console.log(`\n${passed} PostgreSQL assertions passed`);
