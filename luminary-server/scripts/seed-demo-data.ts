import { Client } from 'pg';
import argon2 from 'argon2';

const databaseUrl = process.env.DEMO_SEED_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DEMO_SEED_DATABASE_URL, MIGRATION_DATABASE_URL, or DATABASE_URL is required');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.LUMINARY_ALLOW_PRODUCTION_TEST_SEED !== 'true') {
  console.error('Refusing to seed demo data while NODE_ENV=production. Set LUMINARY_ALLOW_PRODUCTION_TEST_SEED=true only for a disposable demo target.');
  process.exit(1);
}

const PRACTICE_ID = '33333333-3333-4333-8333-000000000001';
const NODE_ID = process.env.NODE_ID || 'demo';
const DEMO_PASSWORD = process.env.LUMINARY_DEMO_PASSWORD || process.env.LUMINARY_TEST_PASSWORD || 'LuminaryDemo2026!';
const id = (group: string, n: number) => `33333333-3333-4333-${group}-${String(n).padStart(12, '0')}`;
type Row = Record<string, unknown>;
const jsonColumns = new Set([
  'provider_identifiers',
  'vitals',
  'diagnoses',
  'responses',
  'submission_snapshot',
  'validation_result',
  'metadata',
  'normalized_result',
  'messages',
  'goals',
  'interventions',
]);

const users = [
  ['a001', 1, 'admin@demo.luminaryhealth.test', 'Tariro Mbeki', 'TM', 'Practice administrator', 'admin', false, null],
  ['a001', 2, 'manager@demo.luminaryhealth.test', 'Farai Dube', 'FD', 'Practice manager', 'manager', false, null],
  ['a001', 3, 'reception@demo.luminaryhealth.test', 'Nyasha Chari', 'NC', 'Reception lead', 'receptionist', false, null],
  ['a001', 4, 'nurse@demo.luminaryhealth.test', 'Chipo Ncube', 'CN', 'Registered nurse', 'nurse', false, 'NUR-84219'],
  ['a001', 5, 'doctor@demo.luminaryhealth.test', 'Dr Anesu Moyo', 'AM', 'Family physician', 'doctor', true, 'MD-49172'],
  ['a001', 6, 'doctor2@demo.luminaryhealth.test', 'Dr Lindiwe Khumalo', 'LK', 'General practitioner', 'doctor', true, 'MD-50638'],
  ['a001', 7, 'billing@demo.luminaryhealth.test', 'Kundai Sithole', 'KS', 'Billing officer', 'manager', false, null],
] as const;

const services = [
  ['CONS-GP', 'GP consultation', 'General practitioner consultation', 45],
  ['REV-CHRONIC', 'Chronic review', 'Chronic medication review', 55],
  ['GLUCOSE', 'Blood glucose test', 'Point-of-care glucose test', 12],
  ['FBC', 'Full blood count', 'Full blood count laboratory panel', 28],
  ['ECG', 'ECG', 'Resting 12 lead electrocardiogram', 35],
  ['NEB', 'Nebulisation', 'Nebulisation treatment', 18],
] as const;

const patients = [
  ['0001', 'Ruvimbo Moyo', 'Ruvimbo', '1984-03-18', 'Female', 'Asthma review', ['Asthma'], ['Salbutamol inhaler'], 'Premier Health Plan', 'PH-100418'],
  ['0002', 'Tendai Ncube', 'Tendai', '1976-11-04', 'Male', 'Hypertension follow up', ['Hypertension'], ['Amlodipine 5mg'], 'Premier Health Plan', 'PH-100529'],
  ['0003', 'Chipo Mutasa', 'Chipo', '1991-07-22', 'Female', 'Antenatal check', ['Pregnancy'], ['Folic acid'], 'UnityCare Gold', 'UC-884201'],
  ['0004', 'Blessing Dlamini', 'Blessing', '1968-01-15', 'Male', 'Diabetes review', ['Type 2 diabetes'], ['Metformin 500mg'], 'UnityCare Gold', 'UC-884337'],
  ['0005', 'Nyasha Sibanda', 'Nyasha', '2007-05-09', 'Female', 'Sore throat', [], [], 'Premier Health Plan', 'PH-100612'],
  ['0006', 'Kudakwashe Zhou', 'Kuda', '1989-12-30', 'Male', 'Back pain', ['Lumbar strain'], ['Ibuprofen as needed'], 'Self-pay', 'CASH-0006'],
  ['0007', 'Tinashe Chikore', 'Tinashe', '1972-09-03', 'Female', 'Chest discomfort', ['Hyperlipidaemia'], ['Atorvastatin 20mg'], 'Premier Health Plan', 'PH-100744'],
  ['0008', 'Lerato Maseko', 'Lerato', '1998-02-11', 'Female', 'Migraine follow up', ['Migraine'], ['Sumatriptan 50mg'], 'UnityCare Gold', 'UC-884419'],
  ['0009', 'Simbarashe Gumbo', 'Simba', '1959-10-27', 'Male', 'COPD review', ['COPD'], ['Tiotropium inhaler'], 'Premier Health Plan', 'PH-100851'],
  ['0010', 'Vimbai Maposa', 'Vimbai', '1982-06-14', 'Female', 'UTI symptoms', [], [], 'UnityCare Gold', 'UC-884528'],
  ['0011', 'Munyaradzi Banda', 'Munya', '1979-08-21', 'Male', 'Annual wellness', [], [], 'Premier Health Plan', 'PH-101006'],
  ['0012', 'Anotida Nyathi', 'Ano', '2014-04-06', 'Female', 'Paediatric fever', [], [], 'Premier Health Plan', 'PH-101117'],
  ['0013', 'Nokutenda Shumba', 'Noku', '1995-01-28', 'Female', 'Anxiety review', ['Generalised anxiety'], ['Sertraline 50mg'], 'UnityCare Gold', 'UC-884691'],
  ['0014', 'Mandla Khumalo', 'Mandla', '1965-12-02', 'Male', 'Knee osteoarthritis', ['Osteoarthritis'], ['Paracetamol'], 'Premier Health Plan', 'PH-101248'],
  ['0015', 'Rudo Hove', 'Rudo', '1987-03-25', 'Female', 'Thyroid follow up', ['Hypothyroidism'], ['Levothyroxine 50mcg'], 'UnityCare Gold', 'UC-884705'],
  ['0016', 'Tatenda Mlambo', 'Tatenda', '2001-09-19', 'Male', 'Sports injury', ['Ankle sprain'], [], 'Self-pay', 'CASH-0016'],
  ['0017', 'Kudzai Masuka', 'Kudzai', '1974-05-31', 'Female', 'Anaemia review', ['Iron deficiency anaemia'], ['Ferrous sulphate'], 'Premier Health Plan', 'PH-101399'],
  ['0018', 'Sipho Ndlovu', 'Sipho', '1980-02-08', 'Male', 'Sinusitis', [], [], 'UnityCare Gold', 'UC-884812'],
  ['0019', 'Makanaka Dube', 'Maka', '2010-11-13', 'Female', 'Asthma action plan', ['Asthma'], ['Beclomethasone inhaler'], 'Premier Health Plan', 'PH-101450'],
  ['0020', 'Farirai Chirwa', 'Farirai', '1992-07-17', 'Male', 'Gastritis', ['Gastritis'], ['Omeprazole 20mg'], 'UnityCare Gold', 'UC-884930'],
] as const;

const prescriptions = [
  ['Salbutamol', '100mcg', 'inhaled', '2 puffs when needed', 30],
  ['Amlodipine', '5mg', 'oral', 'once daily', 90],
  ['Folic acid', '5mg', 'oral', 'once daily', 30],
  ['Metformin', '500mg', 'oral', 'twice daily with meals', 60],
  ['Amoxicillin', '500mg', 'oral', 'three times daily', 5],
  ['Ibuprofen', '400mg', 'oral', 'three times daily after food', 5],
  ['Atorvastatin', '20mg', 'oral', 'at night', 90],
  ['Sumatriptan', '50mg', 'oral', 'at migraine onset', 10],
  ['Tiotropium', '18mcg', 'inhaled', 'once daily', 30],
  ['Nitrofurantoin', '100mg', 'oral', 'twice daily', 5],
] as const;

const client = new Client({ connectionString: databaseUrl });

const upsert = async (table: string, row: Row, conflict = 'id'): Promise<void> => {
  const keys = Object.keys(row);
  const columns = keys.map((key) => `"${key}"`).join(', ');
  const params = keys.map((_, index) => `$${index + 1}`).join(', ');
  const updates = keys.filter((key) => key !== conflict).map((key) => `"${key}" = EXCLUDED."${key}"`).join(', ');
  await client.query(
    `INSERT INTO luminary.${table} (${columns}) VALUES (${params}) ON CONFLICT ("${conflict}") DO UPDATE SET ${updates}`,
    keys.map((key) => (jsonColumns.has(key) ? JSON.stringify(row[key] ?? null) : row[key])),
  );
};

await client.connect();

try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('luminary.practice_id', $1, true)`, [PRACTICE_ID]);
  await client.query(`SELECT set_config('luminary.node', $1, true)`, [NODE_ID]);

  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });

  await upsert('practice', {
    id: PRACTICE_ID,
    name: 'Harare Family Health Demo',
    short_name: 'Harare Demo',
    address_line: '24 Borrowdale Road',
    city: 'Harare',
    phone: '+263 242 555 018',
    email: 'hello@demo.luminaryhealth.test',
    primary_currency: 'USD',
    secondary_currency: 'ZWL',
    usd_rate: 13500,
    plan: 'professional',
    home_node: NODE_ID,
    deleted_at: null,
  });

  await upsert('practice_settings', {
    practice_id: PRACTICE_ID,
    id: id('b001', 1),
    opens_at: '08:00',
    closes_at: '17:00',
    slot_minutes: 15,
    open_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    idle_timeout_minutes: 20,
    minimum_password_length: 12,
    break_glass_enabled: true,
    enforce_registration: true,
    nh263_provider_number: 'NH263-DEMO-0192',
    nh263_endpoint: 'https://sandbox-switch.demo.invalid/claims',
    sms_sender_id: 'LUMDEMO',
    sms_gateway: 'Demo gateway',
    nh263_enabled: true,
    nh263_environment: 'sandbox',
    nh263_organisation_identifier: 'ORG-DEMO-0192',
    nh263_secret_ref: 'secret/demo/nh263',
    claims_status_poll_minutes: 30,
    claims_capabilities: ['manual', 'email_pdf', 'nh263_sandbox'],
    claims_integration_health: 'healthy',
    deleted_at: null,
  }, 'practice_id');

  for (let room = 1; room <= 3; room += 1) {
    await upsert('room', { id: id('c001', room), practice_id: PRACTICE_ID, name: room === 3 ? 'Treatment bay' : `Room ${room}`, kind: room === 3 ? 'Nursing' : 'Consulting', active: true, deleted_at: null });
  }

  for (const user of users) {
    const [group, n, email, name, initials, jobTitle, role, isProvider, registration] = user;
    await upsert('app_user', {
      id: id(group, n),
      practice_id: PRACTICE_ID,
      email,
      full_name: name,
      display_name: name.startsWith('Dr ') ? name.replace('Dr ', 'Dr. ') : name,
      initials,
      job_title: jobTitle,
      role,
      password_hash: passwordHash,
      registration_number: registration,
      registration_expires: registration ? '2028-12-31' : null,
      provider_identifiers: isProvider ? { hpcz: registration, nh263: `PRV-${registration}` } : {},
      is_provider: isProvider,
      active: true,
      on_leave_until: null,
      deleted_at: null,
    });
  }

  const payerPremier = id('d001', 1);
  const payerUnity = id('d001', 2);
  const schemePremier = id('d002', 1);
  const schemeUnity = id('d002', 2);
  await upsert('payer', { id: payerPremier, practice_id: PRACTICE_ID, name: 'Premier Medical Aid', active: true, deleted_at: null });
  await upsert('payer', { id: payerUnity, practice_id: PRACTICE_ID, name: 'UnityCare Health Fund', active: true, deleted_at: null });
  await upsert('scheme', { id: schemePremier, practice_id: PRACTICE_ID, name: 'Premier Health Plan', reimburse_percent: 80, requires_preauth: false, active: true, payer_id: payerPremier, deleted_at: null });
  await upsert('scheme', { id: schemeUnity, practice_id: PRACTICE_ID, name: 'UnityCare Gold', reimburse_percent: 85, requires_preauth: true, active: true, payer_id: payerUnity, deleted_at: null });

  for (let i = 0; i < services.length; i += 1) {
    const [code, name, description, price] = services[i];
    const serviceId = id('e001', i + 1);
    await upsert('service', { id: serviceId, practice_id: PRACTICE_ID, internal_code: code, display_name: name, clinical_name: name, billing_description: description, category: i < 2 ? 'Consultation' : 'Diagnostics', department: i < 2 ? 'General Practice' : 'Clinical Services', service_type: 'service', default_duration: i < 2 ? 30 : 15, default_quantity: 1, billable: true, billing_trigger: 'ON_COMPLETION', default_tariff_code: code, notes: 'Demo service catalogue item', active: true, deleted_at: null });
    await upsert('service_price', { id: id('e002', i + 1), practice_id: PRACTICE_ID, service_id: serviceId, amount: price, currency: 'USD', effective_from: '2026-01-01', effective_to: null, created_by: id('a001', 2), deleted_at: null });
    await upsert('service_tariff', { id: id('e003', i + 1), practice_id: PRACTICE_ID, code, description, price, currency: 'USD', active: true, deleted_at: null });
    await upsert('tariff', { id: id('e004', i + 1), practice_id: PRACTICE_ID, payer_id: payerPremier, plan_id: schemePremier, service_id: serviceId, code, description, rate: Math.round(price * 80) / 100, currency: 'USD', effective_from: '2026-01-01', effective_to: null, active: true, source: 'demo', created_by: id('a001', 2), deleted_at: null });
    await upsert('tariff', { id: id('e005', i + 1), practice_id: PRACTICE_ID, payer_id: payerUnity, plan_id: schemeUnity, service_id: serviceId, code, description, rate: Math.round(price * 85) / 100, currency: 'USD', effective_from: '2026-01-01', effective_to: null, active: true, source: 'demo', created_by: id('a001', 2), deleted_at: null });
    await upsert('service_alias', { id: id('e006', i + 1), practice_id: PRACTICE_ID, service_id: serviceId, alias: description, source: 'demo', payer_id: null, approved_by: id('a001', 2), approved_at: '2026-01-01T08:00:00Z', deleted_at: null });
    await upsert('service_visit_type', { id: id('e007', i + 1), practice_id: PRACTICE_ID, service_id: serviceId, visit_type: name, deleted_at: null });
  }

  for (let i = 0; i < patients.length; i += 1) {
    const [number, fullName, preferredName, dob, sex, reason, conditions, medications, planName, memberNo] = patients[i];
    const patientId = id('f001', i + 1);
    const providerId = i % 2 === 0 ? id('a001', 5) : id('a001', 6);
    const schemeId = planName === 'Premier Health Plan' ? schemePremier : planName === 'UnityCare Gold' ? schemeUnity : null;
    const payerId = planName === 'Premier Health Plan' ? payerPremier : planName === 'UnityCare Gold' ? payerUnity : null;
    const visitDate = new Date(Date.UTC(2026, 8, 1 + i, 8 + (i % 7), i % 2 ? 30 : 0));
    const serviceIndex = i % services.length;
    const [code, serviceName, description, price] = services[serviceIndex];
    const estimatedFunder = schemeId ? Math.round(price * (planName === 'UnityCare Gold' ? 85 : 80)) / 100 : 0;
    const patientPortion = Math.round((price - estimatedFunder) * 100) / 100;
    const invoiceStatus = i % 5 === 0 ? 'pending' : i % 4 === 0 ? 'part_paid' : 'paid';
    const paid = invoiceStatus === 'paid' ? patientPortion : invoiceStatus === 'part_paid' ? Math.round(patientPortion * 50) / 100 : 0;
    const claimStatus = !schemeId ? 'DRAFT' : i % 6 === 0 ? 'REJECTED' : i % 4 === 0 ? 'PARTIALLY_APPROVED' : i % 3 === 0 ? 'SUBMITTED' : 'APPROVED';
    const approved = claimStatus === 'REJECTED' || claimStatus === 'SUBMITTED' ? 0 : claimStatus === 'PARTIALLY_APPROVED' ? Math.round(estimatedFunder * 60) / 100 : estimatedFunder;
    const rejected = Math.max(0, Math.round((estimatedFunder - approved) * 100) / 100);
    const encounterId = id('f003', i + 1);
    const appointmentId = id('f004', i + 1);
    const invoiceId = id('f007', i + 1);
    const invoiceLineId = id('f008', i + 1);
    const claimId = id('f010', i + 1);

    await upsert('patient', { id: patientId, practice_id: PRACTICE_ID, reference: `HFH-${number}`, full_name: fullName, preferred_name: preferredName, date_of_birth: dob, sex, national_id: `demo-${number}`, marital_status: i % 3 === 0 ? 'Married' : 'Single', occupation: i % 4 === 0 ? 'Teacher' : i % 4 === 1 ? 'Trader' : i % 4 === 2 ? 'Student' : 'Office worker', language: i % 2 === 0 ? 'English' : 'Shona', phone: `+263 77 ${400000 + i * 137}`, email: `${preferredName.toLowerCase()}.${number}@demo.patient.invalid`, address_street: `${10 + i} Jacaranda Avenue`, address_suburb: i % 2 === 0 ? 'Avondale' : 'Borrowdale', address_city: 'Harare', preferred_contact: 'SMS', emergency_name: i % 2 === 0 ? 'Memory Moyo' : 'Brian Dube', emergency_relation: i % 2 === 0 ? 'Spouse' : 'Sibling', emergency_phone: `+263 78 ${500000 + i * 149}`, scheme_id: schemeId, member_number: memberNo, principal_member: fullName, dependant_code: i % 3 === 0 ? '02' : '00', cover_valid_until: schemeId ? '2027-12-31' : null, cover_status: schemeId ? 'Verified' : 'Self-pay', member_suffix: i % 3 === 0 ? '02' : '00', relationship_to_member: i % 3 === 0 ? 'dependant' : 'self', cover_effective_from: schemeId ? '2025-01-01' : null, cover_external_ref: schemeId ? `ELIG-${number}` : null, cover_verified_at: schemeId ? visitDate.toISOString() : null, cover_verification_status: schemeId ? 'verified' : 'manual', blood_type: ['O+', 'A+', 'B+', 'AB+'][i % 4], allergies_reviewed: true, allergies: i % 7 === 0 ? ['Penicillin'] : [], conditions, medications, family_history: i % 5 === 0 ? ['Hypertension'] : [], immunisations: ['COVID-19', 'Tetanus'], smoking: i % 6 === 0 ? 'Former smoker' : 'Never', alcohol: 'Occasional', exercise: i % 2 === 0 ? 'Walks weekly' : 'Limited', risk: i % 6 === 0 ? 'High' : i % 4 === 0 ? 'Moderate' : 'Low', clinical_summary: reason, consent_treatment: true, consent_comms: true, consent_data_sharing: true, primary_provider_id: providerId, registered_on: '2026-01-15', balance: Math.max(0, patientPortion - paid), status: i % 6 === 0 ? 'Review' : 'Active', deleted_at: null });

    await upsert('claim_eligibility_result', { id: id('f002', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, payer_id: payerId, scheme_id: schemeId, verification_method: schemeId ? 'nh263_sandbox' : 'manual', membership_valid: Boolean(schemeId), eligible: Boolean(schemeId), member_status: schemeId ? 'active' : 'self_pay', plan_name: planName, verification_reference: `ELIG-${number}`, response_timestamp: visitDate.toISOString(), messages: schemeId ? [{ level: 'info', text: 'Cover verified in demo sandbox' }] : [{ level: 'info', text: 'Self-pay patient' }], deleted_at: null });
    await upsert('appointment', { id: appointmentId, practice_id: PRACTICE_ID, patient_id: patientId, provider_id: providerId, room_id: id('c001', (i % 2) + 1), starts_at: visitDate.toISOString(), duration_min: 30, visit_type: reason, mode: 'in_person', status: i % 8 === 0 ? 'checked_in' : i % 5 === 0 ? 'booked' : 'completed', deleted_at: null });
    await upsert('encounter', { id: encounterId, practice_id: PRACTICE_ID, patient_id: patientId, appointment_id: appointmentId, author_id: providerId, note_type: 'SOAP note', status: 'signed', vitals: { bp: i % 4 === 0 ? '146/92' : '122/78', pulse: 72 + (i % 12), temp: i % 5 === 0 ? 37.8 : 36.8, weightKg: 58 + i }, vitals_by: id('a001', 4), subjective: `${fullName} attended for ${reason.toLowerCase()}. Symptoms and medication adherence reviewed.`, objective: 'Clinically stable. No acute distress. Examination findings recorded for demo workflow.', assessment: conditions.length ? `${conditions[0]} with ongoing monitoring.` : `${reason}; no red flags identified.`, plan: 'Treat according to protocol, safety-net advice given, follow up arranged as needed.', diagnoses: [{ code: i % 2 === 0 ? 'J45.9' : 'Z00.0', description: conditions[0] || reason, primary: true }], follow_up: i % 3 === 0 ? 'Review in 2 weeks' : 'Review as needed', signed_by: providerId, signed_at: new Date(visitDate.getTime() + 25 * 60000).toISOString(), deleted_at: null });

    const [drug, strength, route, frequency, durationDays] = prescriptions[i % prescriptions.length];
    await upsert('prescription', { id: id('f005', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, encounter_id: encounterId, prescriber_id: providerId, drug, strength, route, frequency, duration_days: durationDays, refills: i % 4 === 0 ? 2 : 0, pharmacy: 'Patient choice', status: i % 9 === 0 ? 'completed' : 'active', deleted_at: null });
    await upsert('lab_result', { id: id('f006', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, test_name: i % 2 === 0 ? 'Full blood count' : 'Random glucose', value: i % 2 === 0 ? (i % 5 === 0 ? 'Hb 10.8' : 'Normal') : `${5.4 + (i % 4)} mmol/L`, unit: i % 2 === 0 ? null : 'mmol/L', normal_range: i % 2 === 0 ? 'Hb 12-16 g/dL' : '3.9-7.8 mmol/L', abnormal: i % 5 === 0, resulted_on: visitDate.toISOString().slice(0, 10), reviewed_by: providerId, reviewed_at: new Date(visitDate.getTime() + 2 * 3600_000).toISOString(), deleted_at: null });
    await upsert('invoice', { id: invoiceId, practice_id: PRACTICE_ID, patient_id: patientId, reference: `INV-DEMO-${number}`, issued_on: visitDate.toISOString().slice(0, 10), due_on: new Date(visitDate.getTime() + 14 * 86400_000).toISOString().slice(0, 10), currency: 'USD', total: price, scheme_portion: estimatedFunder, patient_portion: patientPortion, amount_paid: paid, status: invoiceStatus, deleted_at: null });
    await upsert('invoice_line', { id: invoiceLineId, practice_id: PRACTICE_ID, invoice_id: invoiceId, tariff_code: code, description, quantity: 1, unit_price: price, scheme_pays: estimatedFunder, service_id: id('e001', serviceIndex + 1), estimated_funder: estimatedFunder, actual_funder_approved: claimStatus === 'SUBMITTED' ? null : approved, actual_funder_paid: claimStatus === 'APPROVED' ? approved : null, tariff_id: schemeId ? id(planName === 'Premier Health Plan' ? 'e004' : 'e005', serviceIndex + 1) : null, tariff_via: schemeId ? 'plan tariff' : 'self-pay', billing_key: `demo-${number}-${code}`, deleted_at: null });

    if (paid > 0) await upsert('payment', { id: id('f009', i + 1), practice_id: PRACTICE_ID, invoice_id: invoiceId, amount: paid, currency: 'USD', fx_rate: 1, method: i % 3 === 0 ? 'card' : i % 3 === 1 ? 'cash' : 'transfer', received_by: id('a001', 7), received_at: new Date(visitDate.getTime() + 45 * 60000).toISOString(), reverses_id: null, deleted_at: null });

    if (schemeId) {
      await upsert('claim', { id: claimId, practice_id: PRACTICE_ID, invoice_id: invoiceId, patient_id: patientId, claim_number: `CLM-DEMO-${number}`, scheme_id: schemeId, member_number: memberNo, membership_number: memberNo, member_suffix: i % 3 === 0 ? '02' : '00', member_name: fullName, relationship_to_member: i % 3 === 0 ? 'dependant' : 'self', encounter_id: encounterId, payer_id: payerId, service_from_date: visitDate.toISOString().slice(0, 10), service_to_date: visitDate.toISOString().slice(0, 10), claim_type: 'medical_aid', currency: 'USD', total_claimed_amount: estimatedFunder, total_approved_amount: approved, total_rejected_amount: rejected, member_liability: patientPortion + rejected, insurer_liability: approved, submission_channel: i % 2 === 0 ? 'NH263' : 'EMAIL_PDF', external_reference: `EXT-DEMO-${number}`, switch_reference: `SW-DEMO-${number}`, external_status: claimStatus, funder_status: claimStatus, created_by: id('a001', 7), submitted_by: id('a001', 7), status: claimStatus, biometric_at: new Date(visitDate.getTime() + 10 * 60000).toISOString(), biometric_ref: `BIO-${number}`, submitted_at: claimStatus === 'DRAFT' ? null : new Date(visitDate.getTime() + 60 * 60000).toISOString(), switch_ref: `SW-DEMO-${number}`, responses: [{ at: visitDate.toISOString(), status: claimStatus, message: 'Demo switch response' }], rejection_code: claimStatus === 'REJECTED' ? 'COVER_EXPIRED' : null, last_checked_at: new Date(visitDate.getTime() + 3 * 3600_000).toISOString(), completed_at: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'].includes(claimStatus) ? new Date(visitDate.getTime() + 4 * 3600_000).toISOString() : null, notes: 'Seeded realistic demo claim.', submission_snapshot: { invoice: `INV-DEMO-${number}`, patient: fullName, service: description }, validation_result: { valid: claimStatus !== 'REJECTED', errors: claimStatus === 'REJECTED' ? ['Cover expired on service date'] : [], warnings: [] }, idempotency_key: `demo-claim-${number}`, deleted_at: null });
      await upsert('claim_line', { id: id('f011', i + 1), practice_id: PRACTICE_ID, claim_id: claimId, invoice_line_id: invoiceLineId, service_id: id('e001', serviceIndex + 1), line_number: 1, tariff_code: code, tariff_description: description, quantity: 1, unit_price: price, claimed_amount: estimatedFunder, approved_amount: approved, rejected_amount: rejected, member_liability: patientPortion + rejected, insurer_liability: approved, service_date: visitDate.toISOString().slice(0, 10), practitioner_id: providerId, referring_provider_id: null, service_location: 'Harare Family Health Demo', status: claimStatus === 'PARTIALLY_APPROVED' ? 'PARTIALLY_APPROVED' : claimStatus === 'REJECTED' ? 'REJECTED' : claimStatus === 'SUBMITTED' ? 'SUBMITTED' : 'APPROVED', adjudication_reason_code: claimStatus === 'REJECTED' ? 'COVER_EXPIRED' : null, adjudication_reason_description: claimStatus === 'REJECTED' ? 'Cover expired on service date' : null, external_line_reference: `EXT-DEMO-${number}-1`, metadata: { demo: true }, deleted_at: null });
      await upsert('claim_diagnosis', { id: id('f012', i + 1), practice_id: PRACTICE_ID, claim_id: claimId, claim_line_id: id('f011', i + 1), code: i % 2 === 0 ? 'J45.9' : 'Z00.0', description: conditions[0] || reason, kind: 'primary', sequence: 1, source: 'encounter', deleted_at: null });
      await upsert('claim_event', { id: id('f013', i + 1), practice_id: PRACTICE_ID, claim_id: claimId, event_type: 'status_changed', actor_id: id('a001', 7), actor_kind: 'user', previous_status: 'READY_FOR_SUBMISSION', new_status: claimStatus, external_reference: `EXT-DEMO-${number}`, metadata: { demo: true }, occurred_at: new Date(visitDate.getTime() + 65 * 60000).toISOString(), deleted_at: null });
      await upsert('claim_transmission', { id: id('f014', i + 1), practice_id: PRACTICE_ID, claim_id: claimId, adapter: i % 2 === 0 ? 'NH263_SANDBOX' : 'EMAIL_PDF', direction: 'outbound', attempt_number: 1, request_reference: `REQ-DEMO-${number}`, external_reference: `EXT-DEMO-${number}`, sent_at: new Date(visitDate.getTime() + 60 * 60000).toISOString(), received_at: claimStatus === 'SUBMITTED' ? null : new Date(visitDate.getTime() + 3 * 3600_000).toISOString(), status: claimStatus === 'SUBMITTED' ? 'sent' : 'succeeded', normalized_result: { status: claimStatus, approvedAmount: approved, rejectedAmount: rejected }, raw_payload_ref: `demo://claims/${number}.json`, error_code: claimStatus === 'REJECTED' ? 'COVER_EXPIRED' : null, error_message: claimStatus === 'REJECTED' ? 'Cover expired on service date' : null, deleted_at: null });
      if (claimStatus !== 'SUBMITTED') await upsert('claim_adjudication', { id: id('f015', i + 1), practice_id: PRACTICE_ID, claim_id: claimId, payer_reference: `PAY-DEMO-${number}`, adjudicated_at: new Date(visitDate.getTime() + 3 * 3600_000).toISOString(), claimed_amount: estimatedFunder, approved_amount: approved, rejected_amount: rejected, member_liability: patientPortion + rejected, insurer_liability: approved, result: claimStatus === 'REJECTED' ? 'REJECTED' : claimStatus === 'PARTIALLY_APPROVED' ? 'PARTIALLY_APPROVED' : 'APPROVED', notes: claimStatus === 'REJECTED' ? 'Rejected in seeded demo to show follow-up workflow.' : 'Adjudicated in seeded demo.', raw_payload_ref: `demo://adjudications/${number}.json`, deleted_at: null });
    }

    await upsert('care_plan', { id: id('f016', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, encounter_id: encounterId, name: conditions.length ? `${conditions[0]} care plan` : `${reason} follow-up plan`, status: i % 7 === 0 ? 'paused' : 'active', goals: [{ text: 'Improve symptom control', due: '2026-12-31' }], interventions: [{ text: 'Medication adherence review' }, { text: 'Follow-up appointment' }], progress: 30 + (i % 6) * 10, next_review: new Date(visitDate.getTime() + 45 * 86400_000).toISOString().slice(0, 10), created_by: providerId, deleted_at: null });
    if (i % 5 === 0) await upsert('referral', { id: id('f017', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, encounter_id: encounterId, referred_to: i % 10 === 0 ? 'Harare Cardiology Centre' : 'City Imaging', specialty: i % 10 === 0 ? 'Cardiology' : 'Radiology', reason: i % 10 === 0 ? 'Further assessment of chest symptoms' : 'Diagnostic imaging requested', urgency: i % 10 === 0 ? 'urgent' : 'routine', status: 'sent', notes: 'Seeded referral for demo workflow.', created_by: providerId, sent_at: new Date(visitDate.getTime() + 40 * 60000).toISOString(), completed_at: null, deleted_at: null });
    await upsert('message', { id: id('f018', i + 1), practice_id: PRACTICE_ID, patient_id: patientId, channel: 'sms', template: i % 3 === 0 ? 'claim_update' : 'appointment_followup', body: i % 3 === 0 ? `Hello ${preferredName}, your claim CLM-DEMO-${number} has been updated.` : `Hello ${preferredName}, thank you for visiting Harare Family Health Demo.`, status: i % 4 === 0 ? 'sent' : 'queued', sent_by: id('a001', 3), queued_at: new Date(visitDate.getTime() + 2 * 3600_000).toISOString(), sent_at: i % 4 === 0 ? new Date(visitDate.getTime() + 2.1 * 3600_000).toISOString() : null, deleted_at: null });
  }

  await client.query('COMMIT');
  console.log(`seeded demo practice with ${users.length} users and ${patients.length} realistic patient records`);
  console.log('demo credentials:');
  for (const [, , email] of users) console.log(`  ${email} / ${DEMO_PASSWORD}`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
