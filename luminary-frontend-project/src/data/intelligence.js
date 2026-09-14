export const aiAgentRoster = [
  { id: 'receptionist', name: 'AI Receptionist', role: '24/7 appointment booking', detail: 'Books via WhatsApp, verifies eligibility, sends confirmations, handles rescheduling.', metrics: [{ label: 'Booked this week', value: '124' }, { label: 'Accuracy', value: '94%' }], lastAction: 'Booked follow up for Tawanda Mutsvangwa · 6 min ago' },
  { id: 'claims', name: 'AI Claims Agent', role: 'NH263 claim monitoring', detail: 'Watches switch responses, flags rejection patterns, drafts resubmissions.', metrics: [{ label: 'Claims monitored', value: '156' }, { label: 'Rejections prevented', value: '12' }], lastAction: 'Drafted resubmission for CLM-2026-0141 · 22 min ago' },
  { id: 'collections', name: 'AI Collections', role: 'Payment follow up', detail: 'Multi channel outreach, payment plan offers, escalation before write off.', metrics: [{ label: 'Recovered', value: 'USD 260' }, { label: 'Success rate', value: '78%' }], lastAction: 'Payment plan accepted by Chiedza Mutasa · 1h ago' },
  { id: 'followup', name: 'AI Follow Up Agent', role: 'Proactive patient recall', detail: 'Identifies due follow ups, schedules recalls, tracks compliance.', metrics: [{ label: 'Recalls scheduled', value: '10/12' }, { label: 'Response rate', value: '92%' }], lastAction: 'Queued hypertension recall batch · 2h ago' },
  { id: 'manager', name: 'AI Practice Manager', role: 'Daily intelligence briefings', detail: 'Trend analysis, anomaly detection, forecasting, and recommendations.', metrics: [{ label: 'Insights today', value: '7' }, { label: 'Forecast accuracy', value: '89%' }], lastAction: 'Flagged cardiology follow up surge · 3h ago' },
];

export const smartInsights = [
  { title: 'Cardiology follow up surge', detail: 'Follow up volume is 18% above the weekly baseline. Dr. Park’s Thursday block is the constraint, opening 2 slots would absorb the backlog.', severity: 'Attention', tone: 'warm', source: 'Scheduling · Clinical' },
  { title: 'Claim rejection pattern detected', detail: '3 of the last 20 rejections share code R204 (membership suspended). Eligibility pre-check at booking would have caught all three.', severity: 'Action', tone: 'alert', source: 'Claims · NH263 switch' },
  { title: 'No show risk concentrated on Mondays', detail: 'Monday 08:00 to 10:00 slots carry 2.4× the average no show rate. Same morning SMS confirmation is recommended for this window.', severity: 'Recommendation', tone: 'neutral', source: 'Appointments · Communications' },
  { title: 'Collections ahead of forecast', detail: 'August collections are tracking USD 95 above forecast, driven by the overdue-balance outreach campaign (40% recovery).', severity: 'Positive', tone: 'success', source: 'Billing · Campaigns' },
];

// Frontend-only answer engine for Ask Luminary; the real assistant will query the API layer.

// Frontend-only answer engine for Ask Luminary; the real assistant will query the API layer.
export const askLuminaryKnowledge = [
  { keywords: ['ruvimbo', 'moyo'], sources: 'Patients · Clinical · Billing', answer: 'Ruvimbo Moyo (PT-2048, 39F) has hypertension managed on Amlodipine 5mg, BP 128/82 at her Jun 19 review, within target. Her Hypertension Management care plan is 85% complete, next review Jul 19. Outstanding balance: USD 60.00. Next visit: today 10:30 with Dr. Chen.' },
  { keywords: ['no-show', 'no show', 'noshow'], sources: 'Appointments · Reports', answer: 'The no show rate is 4.8%, down from 7.2% six weeks ago, the reminder sweeps are working. Risk is concentrated in Monday 08:00 to 10:00 slots (2.4× average). Today, 19 of 24 appointments are confirmed.' },
  { keywords: ['claim', 'nh263', 'reject'], sources: 'Claims · NH263 switch', answer: 'Approval rate is 94% with 31 claims submitted this week (USD 875). One active rejection: CLM-2026-0141 (Chiedza Mutasa), code R204, membership suspended; moved to patient responsibility. USD 295 is adjudicated and awaiting remittance.' },
  { keywords: ['revenue', 'collection', 'money', 'billing'], sources: 'Billing · Reports', answer: 'Collections are USD 1,320 this month, +12.4% and 37% above March. Outstanding balances total USD 600 across 18 accounts. The overdue balance campaign has recovered USD 220 so far. Payer mix: 58% NH263, 27% self pay.' },
  { keywords: ['today', 'schedule', 'appointment'], sources: 'Appointments · Clinical', answer: 'Today has 24 appointments; the next four in the queue are Nyasha Chari (09:00, new patient, Dr. Chen), Tawanda Mutsvangwa (09:45, follow up, Dr. Ahmed), Ruvimbo Moyo (10:30, blood pressure review, Dr. Chen), and Chiedza Mutasa (11:15, cardiology follow up, Dr. Park). 19 confirmations received.' },
  { keywords: ['follow-up', 'follow up', 'recall'], sources: 'Clinical · Communications', answer: '14 follow ups are due, 9 within 48 hours. The AI Follow Up Agent has scheduled 10 of 12 recalls (92% response rate), and the hypertension recall campaign has produced 23 bookings this month.' },
];

export const askLuminaryFallback = {
  sources: 'All modules',
  answer: 'I searched patients, appointments, billing, claims, and communications but need a bit more to go on. Try asking about a patient by name, today’s schedule, no shows, claims, or revenue.',
};

export const AI_TABS = ['Agents', 'Smart analytics', 'Ask Luminary'];
