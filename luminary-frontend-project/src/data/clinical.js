export const visitStatusFlow = ['Booked', 'Checked in', 'In triage', 'Ready for provider', 'In consultation', 'Completed'];

export const visitStatusTone = {
  'Booked': 'neutral',
  'Checked in': 'warm',
  'In triage': 'warm',
  'Ready for provider': 'success',
  'In consultation': 'accent',
  'Completed': 'success',
  'No-show': 'alert',
  'Cancelled': 'alert',
};

export const clinicalQueue = [
  { patient: 'Ruvimbo Moyo', reason: 'Blood pressure review', status: 'Ready', tone: 'success', eta: '10:30' },
  { patient: 'Tariro Gumbo', reason: 'Cardiology results follow up', status: 'Pending', tone: 'warm', eta: '12:15' },
  { patient: 'Tawanda Mutsvangwa', reason: 'Medication adherence check', status: 'Awaiting note', tone: 'neutral', eta: '09:45' },
  { patient: 'Chiedza Mutasa', reason: 'Cardiology follow up, coverage suspended', status: 'Attention', tone: 'alert', eta: '11:15' },
  { patient: 'Farai Nyamande', reason: 'Postoperative wound check', status: 'Ready', tone: 'success', eta: '14:15' },
  { patient: 'Kudzai Machingura', reason: 'Metabolic lab signoff', status: 'Ready', tone: 'success', eta: '15:00' },
  { patient: 'Tendai Moyo', reason: 'Medication review', status: 'Pending', tone: 'warm', eta: '16:00' },
];

export const prescriptionsByPatient = {
  'Ruvimbo Moyo': [
    { id: 'RX-001', drug: 'Amlodipine', strength: '5mg', frequency: 'Once daily', status: 'Active', refills: '2', daysSupply: '30', lastFilled: 'Jun 15', nextRefill: 'Jul 15', pharmacy: 'CVS Downtown', tone: 'success' },
    { id: 'RX-002', drug: 'Cetirizine', strength: '10mg', frequency: 'As needed', status: 'Active', refills: '11', daysSupply: '60', lastFilled: 'May 20', nextRefill: 'Jul 20', pharmacy: 'CVS Downtown', tone: 'success' },
  ],
  'Tariro Gumbo': [
    { id: 'RX-003', drug: 'Topiramate', strength: '25mg', frequency: 'Twice daily', status: 'Active', refills: '0', daysSupply: '30', lastFilled: 'Jun 10', nextRefill: 'Jul 10', pharmacy: 'Harare Pharma', tone: 'warm' },
    { id: 'RX-004', drug: 'Aspirin', strength: '81mg', frequency: 'Once daily', status: 'Active', refills: '5', daysSupply: '90', lastFilled: 'May 01', nextRefill: 'Aug 01', pharmacy: 'Harare Pharma', tone: 'success' },
  ],
  'Tawanda Mutsvangwa': [
    { id: 'RX-005', drug: 'Sumatriptan', strength: '50mg', frequency: 'As needed', status: 'Active', refills: '3', daysSupply: '9', lastFilled: 'Jun 18', nextRefill: 'On demand', pharmacy: 'ExpressMed', tone: 'success' },
    { id: 'RX-006', drug: 'Vitamin D', strength: '2000IU', frequency: 'Once daily', status: 'Active', refills: '12', daysSupply: '180', lastFilled: 'Jun 01', nextRefill: 'Dec 01', pharmacy: 'ExpressMed', tone: 'success' },
  ],
  'Kudzai Machingura': [
    { id: 'RX-007', drug: 'Metformin', strength: '500mg', frequency: 'Twice daily', status: 'Active', refills: '4', daysSupply: '30', lastFilled: 'Aug 12', nextRefill: 'Sep 12', pharmacy: 'MainPharm', tone: 'success' },
    { id: 'RX-008', drug: 'Omega-3', strength: '1000mg', frequency: 'Once daily', status: 'Inactive', refills: '0', daysSupply: '90', lastFilled: 'Jun 10', nextRefill: 'Review needed', pharmacy: 'MainPharm', tone: 'alert' },
  ],
  'Chiedza Mutasa': [
    { id: 'RX-009', drug: 'Apixaban', strength: '5mg', frequency: 'Twice daily', status: 'Active', refills: '1', daysSupply: '30', lastFilled: 'Aug 20', nextRefill: 'Sep 19', pharmacy: 'Harare Pharma', tone: 'warm' },
    { id: 'RX-010', drug: 'Bisoprolol', strength: '2.5mg', frequency: 'Once daily', status: 'Active', refills: '3', daysSupply: '30', lastFilled: 'Aug 20', nextRefill: 'Sep 19', pharmacy: 'Harare Pharma', tone: 'success' },
  ],
  'Farai Nyamande': [
    { id: 'RX-011', drug: 'Amoxicillin', strength: '500mg', frequency: 'Three times daily', status: 'Active', refills: '0', daysSupply: '7', lastFilled: 'Aug 18', nextRefill: 'Course ends Aug 25', pharmacy: 'ExpressMed', tone: 'warm' },
    { id: 'RX-012', drug: 'Paracetamol', strength: '500mg', frequency: 'As needed', status: 'Active', refills: '2', daysSupply: '14', lastFilled: 'Aug 18', nextRefill: 'On demand', pharmacy: 'ExpressMed', tone: 'success' },
  ],
  'Nyasha Chari': [],
  'Tendai Moyo': [
    { id: 'RX-013', drug: 'Losartan', strength: '50mg', frequency: 'Once daily', status: 'Active', refills: '2', daysSupply: '30', lastFilled: 'Aug 21', nextRefill: 'Sep 20', pharmacy: 'MainPharm', tone: 'success' },
  ],
};

export const labResultsByPatient = {
  'Ruvimbo Moyo': [
    { test: 'Blood Pressure', value: '128/82', unit: 'mmHg', normal: '<130/85', status: 'Normal', date: 'Jun 19', tone: 'success' },
    { test: 'Glucose', value: '92', unit: 'mg/dL', normal: '70-100', status: 'Normal', date: 'Jun 19', tone: 'success' },
    { test: 'Cholesterol', value: '185', unit: 'mg/dL', normal: '<200', status: 'Normal', date: 'May 15', tone: 'success' },
  ],
  'Tariro Gumbo': [
    { test: 'Troponin', value: '0.02', unit: 'ng/mL', normal: '<0.04', status: 'Normal', date: 'Jun 16', tone: 'success' },
    { test: 'ECG', value: 'Normal sinus', unit: 'rhythm', normal: 'NSR', status: 'Normal', date: 'Jun 16', tone: 'success' },
    { test: 'BNP', value: '85', unit: 'pg/mL', normal: '<100', status: 'Normal', date: 'Jun 10', tone: 'success' },
  ],
  'Tawanda Mutsvangwa': [
    { test: 'Triptans', value: 'Effective', unit: 'response', normal: 'Symptom relief', status: 'Good', date: 'Jun 18', tone: 'success' },
    { test: 'Magnesium', value: '2.1', unit: 'mg/dL', normal: '1.8-2.6', status: 'Normal', date: 'May 20', tone: 'success' },
  ],
  'Kudzai Machingura': [
    { test: 'Glucose', value: '98', unit: 'mg/dL', normal: '70-100', status: 'Normal', date: 'Aug 09', tone: 'success' },
    { test: 'HbA1c', value: '5.6', unit: '%', normal: '<5.7', status: 'Normal', date: 'Aug 09', tone: 'success' },
    { test: 'Triglycerides', value: '145', unit: 'mg/dL', normal: '<150', status: 'Normal', date: 'Aug 09', tone: 'success' },
  ],
  'Chiedza Mutasa': [
    { test: 'INR', value: '3.4', unit: 'ratio', normal: '2.0-3.0', status: 'Abnormal', date: 'Aug 20', tone: 'alert' },
    { test: 'Heart rate', value: '104', unit: 'bpm', normal: '60-100', status: 'Abnormal', date: 'Aug 20', tone: 'alert' },
    { test: 'Potassium', value: '4.1', unit: 'mmol/L', normal: '3.5-5.0', status: 'Normal', date: 'Aug 20', tone: 'success' },
  ],
  'Farai Nyamande': [
    { test: 'White cell count', value: '11.8', unit: '10⁹/L', normal: '4.0-11.0', status: 'Abnormal', date: 'Aug 18', tone: 'warm' },
    { test: 'CRP', value: '18', unit: 'mg/L', normal: '<10', status: 'Abnormal', date: 'Aug 18', tone: 'warm' },
    { test: 'Haemoglobin', value: '13.9', unit: 'g/dL', normal: '13.0-17.0', status: 'Normal', date: 'Aug 18', tone: 'success' },
  ],
  'Nyasha Chari': [],
  'Tendai Moyo': [
    { test: 'Blood Pressure', value: '142/91', unit: 'mmHg', normal: '<130/85', status: 'Abnormal', date: 'Aug 21', tone: 'warm' },
    { test: 'Creatinine', value: '0.9', unit: 'mg/dL', normal: '0.7-1.3', status: 'Normal', date: 'Aug 21', tone: 'success' },
  ],
};

export const carePlansByPatient = {
  'Ruvimbo Moyo': [
    { id: 'CP-001', name: 'Hypertension Management', startDate: 'May 13', status: 'Active', progress: '85%', goals: ['BP <130/85', 'Daily monitoring', 'Reduce sodium'], interventions: ['Amlodipine 5mg', 'Home BP monitoring', 'Dietary counseling'], nextReview: 'Jul 19', tone: 'success' },
  ],
  'Tariro Gumbo': [
    { id: 'CP-002', name: 'Cardiac Rehabilitation', startDate: 'May 30', status: 'Active', progress: '72%', goals: ['Improve cardiac function', 'Exercise tolerance', 'Symptom control'], interventions: ['Aspirin therapy', 'Cardiac PT', 'Stress management'], nextReview: 'Jul 16', tone: 'warm' },
  ],
  'Tawanda Mutsvangwa': [
    { id: 'CP-003', name: 'Migraine Prevention', startDate: 'May 22', status: 'Active', progress: '90%', goals: ['Reduce frequency', 'Minimize severity', 'Improve quality of life'], interventions: ['Sumatriptan PRN', 'Trigger diary', 'Lifestyle modification'], nextReview: 'Jul 22', tone: 'success' },
  ],
  'Kudzai Machingura': [
    { id: 'CP-004', name: 'Weight Management Program', startDate: 'May 11', status: 'Active', progress: '68%', goals: ['Lose 8-10kg', 'Improve metabolic markers', 'Lifestyle change'], interventions: ['Metformin 500mg', 'Nutritionist visits', 'Exercise plan'], nextReview: 'Sep 11', tone: 'warm' },
  ],
  'Chiedza Mutasa': [
    { id: 'CP-005', name: 'Anticoagulation Management', startDate: 'Jul 02', status: 'Active', progress: '45%', goals: ['INR in range 2.0-3.0', 'Prevent stroke', 'Rate control'], interventions: ['Apixaban 5mg', 'Weekly INR checks', 'Bisoprolol titration'], nextReview: 'Sep 02', tone: 'warm' },
  ],
  'Farai Nyamande': [
  { id: 'CP-006', name: 'Postoperative Recovery', startDate: 'Aug 11', status: 'Active', progress: '60%', goals: ['Wound healing', 'Infection clearance', 'Return to activity'], interventions: ['Amoxicillin course', 'Wound review', 'Activity plan'], nextReview: 'Sep 01', tone: 'warm' },
  ],
  'Nyasha Chari': [],
  'Tendai Moyo': [
    { id: 'CP-007', name: 'Hypertension Management', startDate: 'Aug 21', status: 'Active', progress: '20%', goals: ['BP <130/85', 'Medication adherence', 'Reduce sodium'], interventions: ['Losartan 50mg', 'Home BP diary', 'Dietary counselling'], nextReview: 'Sep 20', tone: 'warm' },
  ],
};
