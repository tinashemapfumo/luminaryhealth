/**
 * Encounter notes — the clinical documentation layer.
 *
 * A note is attached to a patient and (usually) to a visit. It moves
 * Draft → Signed, and signing is a one-way legal act: the SOAP body locks and
 * subsequent changes must be appended as addenda, never edited in place.
 * That constraint is enforced in `EncounterNote.jsx`, not just described here.
 */

export const NOTE_STATUS = {
  DRAFT: 'Draft',
  SIGNED: 'Signed',
  AMENDED: 'Amended',
};

export const NOTE_TYPES = ['SOAP note', 'Follow up', 'Procedure note', 'Telehealth', 'Nurse note'];

/** Vitals a nurse captures at check-in, before the doctor sees the patient. */
export const VITALS_FIELDS = [
  { key: 'bp', label: 'Blood pressure', unit: 'mmHg', placeholder: '120/80' },
  { key: 'hr', label: 'Heart rate', unit: 'bpm', placeholder: '72' },
  { key: 'temp', label: 'Temperature', unit: '°C', placeholder: '36.8' },
  { key: 'rr', label: 'Respiratory rate', unit: '/min', placeholder: '16' },
  { key: 'spo2', label: 'SpO₂', unit: '%', placeholder: '98' },
  { key: 'weight', label: 'Weight', unit: 'kg', placeholder: '70' },
  { key: 'height', label: 'Height', unit: 'cm', placeholder: '170' },
];

/** Small ICD-10 subset covering the seeded cohort; a real build queries the API. */
export const ICD10 = [
  { code: 'I10', label: 'Essential (primary) hypertension' },
  { code: 'I25.10', label: 'Chronic ischaemic heart disease' },
  { code: 'I48.91', label: 'Atrial fibrillation, unspecified' },
  { code: 'G43.909', label: 'Migraine, unspecified, not intractable' },
  { code: 'E66.9', label: 'Obesity, unspecified' },
  { code: 'E11.9', label: 'Type 2 diabetes mellitus without complications' },
  { code: 'R51.9', label: 'Headache, unspecified' },
  { code: 'J06.9', label: 'Acute upper respiratory infection' },
  { code: 'Z09', label: 'Encounter for follow up examination' },
  { code: 'Z98.890', label: 'Other specified postprocedural states' },
  { code: 'R03.0', label: 'Elevated blood pressure reading' },
  { code: 'Z00.00', label: 'General adult medical examination' },
];

/** BMI from vitals, when both weight and height are present. */
export function calculateBmi(vitals) {
  const weight = parseFloat(vitals?.weight);
  const height = parseFloat(vitals?.height);
  if (!weight || !height) return null;
  const metres = height / 100;
  const bmi = weight / (metres * metres);
  if (!Number.isFinite(bmi)) return null;
  return Math.round(bmi * 10) / 10;
}

/** Flags vitals outside normal adult range so the doctor sees them immediately. */
export function abnormalVitals(vitals) {
  if (!vitals) return [];
  const flags = [];
  const hr = parseFloat(vitals.hr);
  const temp = parseFloat(vitals.temp);
  const spo2 = parseFloat(vitals.spo2);
  const rr = parseFloat(vitals.rr);

  if (vitals.bp) {
    const [systolic, diastolic] = String(vitals.bp).split('/').map((n) => parseFloat(n));
    if (systolic >= 140 || diastolic >= 90) flags.push({ key: 'bp', text: `BP ${vitals.bp}, hypertensive range` });
    else if (systolic && systolic < 90) flags.push({ key: 'bp', text: `BP ${vitals.bp}, hypotensive` });
  }
  if (hr && (hr > 100 || hr < 50)) flags.push({ key: 'hr', text: `HR ${hr} bpm, ${hr > 100 ? 'tachycardic' : 'bradycardic'}` });
  if (temp && temp >= 38) flags.push({ key: 'temp', text: `Temp ${temp}°C, febrile` });
  if (spo2 && spo2 < 94) flags.push({ key: 'spo2', text: `SpO₂ ${spo2}%, hypoxic` });
  if (rr && (rr > 20 || rr < 10)) flags.push({ key: 'rr', text: `RR ${rr}/min, abnormal` });

  const bmi = calculateBmi(vitals);
  if (bmi && bmi >= 30) flags.push({ key: 'bmi', text: `BMI ${bmi}, obese range` });
  return flags;
}

/** An empty note ready for a given patient and visit. */
export function blankNote({ patientId, patientName, provider, appointmentTime, type = 'SOAP note' }) {
  return {
    id: `NOTE-${patientId}-${Date.now()}`,
    patientId,
    patientName,
    provider,
    appointmentTime: appointmentTime || 'Unscheduled',
    date: 'Today',
    type,
    status: NOTE_STATUS.DRAFT,
    vitals: {},
    vitalsRecordedBy: '',
    subjective: '',
    objective: '',
    assessment: '',
    plan: '',
    diagnoses: [],
    followUp: '',
    signedBy: '',
    signedAt: '',
    addenda: [],
  };
}

export const initialEncounters = [
  {
    id: 'NOTE-PT-2048-001',
    patientId: 'PT-2048',
    patientName: 'Ruvimbo Moyo',
    provider: 'Dr. Chen',
    appointmentTime: '10:30',
    date: 'Aug 19',
    type: 'SOAP note',
    status: NOTE_STATUS.SIGNED,
    vitals: { bp: '128/82', hr: '74', temp: '36.7', rr: '15', spo2: '98', weight: '68', height: '165' },
    vitalsRecordedBy: 'S. Moyo, RN',
    subjective:
      'Attends for routine hypertension review. Reports good adherence to amlodipine with no ankle swelling, dizziness, or headaches. Home readings averaging 126/80. Walking three times weekly as agreed.',
    objective:
      'Well appearing, no distress. BP 128/82 seated, repeated 126/80. Heart sounds normal, no murmurs. Chest clear. No peripheral oedema.',
    assessment:
      'Essential hypertension, well controlled on current therapy. No evidence of end-organ involvement. Cardiovascular risk remains low.',
    plan:
      'Continue amlodipine 5mg daily. Continue home BP diary. Repeat U&E and lipids at next visit. Review in 8 weeks. Reinforced dietary sodium reduction.',
    diagnoses: [{ code: 'I10', label: 'Essential (primary) hypertension' }],
    followUp: 'Review in 8 weeks',
    signedBy: 'Dr. Chen',
    signedAt: 'Aug 19, 2026 11:02',
    addenda: [],
  },
  {
    id: 'NOTE-PT-2210-001',
    patientId: 'PT-2210',
    patientName: 'Chiedza Mutasa',
    provider: 'Dr. Park',
    appointmentTime: '11:15',
    date: 'Aug 20',
    type: 'SOAP note',
    status: NOTE_STATUS.AMENDED,
    vitals: { bp: '138/88', hr: '104', temp: '36.9', rr: '18', spo2: '96', weight: '61', height: '160' },
    vitalsRecordedBy: 'S. Moyo, RN',
    subjective:
      'Reports intermittent palpitations over the past fortnight, worse on exertion. No chest pain or syncope. Taking apixaban and bisoprolol as prescribed.',
    objective:
      'Irregularly irregular pulse at 104. BP 138/88. No signs of cardiac failure. INR 3.4, above target range of 2.0 to 3.0.',
    assessment:
      'Atrial fibrillation with suboptimal rate control. Supratherapeutic INR carries an elevated bleeding risk.',
    plan:
      'Increase bisoprolol to 5mg daily. Hold anticoagulation for 24 hours and repeat INR in 3 days. Counselled on bleeding precautions. Review in one week.',
    diagnoses: [{ code: 'I48.91', label: 'Atrial fibrillation, unspecified' }],
    followUp: 'Repeat INR in 3 days, review in 1 week',
    signedBy: 'Dr. Park',
    signedAt: 'Aug 20, 2026 11:58',
    addenda: [
      {
        text: 'Patient telephoned after the consultation to report that medical aid membership is suspended. Advised that today’s visit moves to self pay and that the INR recheck must still go ahead regardless of cover.',
        by: 'Dr. Park',
        at: 'Aug 20, 2026 15:20',
      },
    ],
  },
  {
    id: 'NOTE-PT-5107-001',
    patientId: 'PT-5107',
    patientName: 'Farai Nyamande',
    provider: 'Dr. Chen',
    appointmentTime: '14:15',
    date: 'Aug 18',
    type: 'Procedure note',
    status: NOTE_STATUS.SIGNED,
    vitals: { bp: '122/76', hr: '82', temp: '37.2', rr: '16', spo2: '98', weight: '78', height: '180' },
    vitalsRecordedBy: 'S. Moyo, RN',
    subjective: 'Day 7 following laparoscopic appendicectomy. Reports mild wound discomfort, no fever at home, tolerating diet.',
    objective: 'Port sites clean and dry, no erythema or discharge. Abdomen soft, not tender. WCC 11.8, CRP 18, both trending down from admission.',
    assessment: 'Satisfactory postoperative recovery. Mildly raised inflammatory markers consistent with normal healing.',
    plan: 'Complete amoxicillin course. Wound review in one week. Return earlier if fever, increasing pain, or discharge.',
    diagnoses: [{ code: 'Z98.890', label: 'Other specified postprocedural states' }],
    followUp: 'Wound review in 1 week',
    signedBy: 'Dr. Chen',
    signedAt: 'Aug 18, 2026 14:51',
    addenda: [],
  },
  {
    id: 'NOTE-PT-3388-001',
    patientId: 'PT-3388',
    patientName: 'Tendai Moyo',
    provider: 'Dr. Ahmed',
    appointmentTime: '16:00',
    date: 'Aug 21',
    type: 'SOAP note',
    status: NOTE_STATUS.DRAFT,
    vitals: { bp: '142/91', hr: '78', temp: '36.6', rr: '16', spo2: '99', weight: '88', height: '174' },
    vitalsRecordedBy: 'S. Moyo, RN',
    subjective:
      'Presents for review four days after starting losartan. Reports no dizziness or cough. Has not yet started a home BP diary.',
    objective: 'BP 142/91 seated. Heart sounds normal. No oedema.',
    assessment: '',
    plan: '',
    diagnoses: [{ code: 'I10', label: 'Essential (primary) hypertension' }],
    followUp: '',
    signedBy: '',
    signedAt: '',
    addenda: [],
  },
  {
    id: 'NOTE-PT-3304-001',
    patientId: 'PT-3304',
    patientName: 'Tawanda Mutsvangwa',
    provider: 'Dr. Ahmed',
    appointmentTime: '09:45',
    date: 'Aug 14',
    type: 'Follow up',
    status: NOTE_STATUS.DRAFT,
    vitals: { bp: '118/74', hr: '68', temp: '36.5', rr: '14', spo2: '99', weight: '72', height: '178' },
    vitalsRecordedBy: 'S. Moyo, RN',
    subjective: 'Migraine frequency reduced from six to two episodes per month since the protocol change. Sumatriptan effective when taken early.',
    objective: 'Neurological examination normal. No focal deficit. Fundi normal.',
    assessment: '',
    plan: '',
    diagnoses: [{ code: 'G43.909', label: 'Migraine, unspecified, not intractable' }],
    followUp: '',
    signedBy: '',
    signedAt: '',
    addenda: [],
  },
];
