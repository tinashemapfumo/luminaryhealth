export const communicationLog = [
  { patient: 'Ruvimbo Moyo', channel: 'SMS', type: 'Appointment reminder', message: 'Reminder: your visit with Dr. Chen is today at 10:30.', time: '08:02', status: 'Delivered', tone: 'success' },
  { patient: 'Tawanda Mutsvangwa', channel: 'WhatsApp', type: 'Confirmation request', message: 'Please confirm your follow up appointment for today at 09:45.', time: '07:45', status: 'Confirmed', tone: 'success' },
  { patient: 'Tariro Gumbo', channel: 'SMS', type: 'Pre-visit form', message: 'Complete your cardiology intake questionnaire before 12:00.', time: '07:30', status: 'Pending', tone: 'warm' },
  { patient: 'Chiedza Mutasa', channel: 'Email', type: 'Balance reminder', message: 'Invoice INV-2024-003 is overdue. Payment options are available online.', time: 'Yesterday', status: 'Sent', tone: 'neutral' },
  { patient: 'Kudzai Machingura', channel: 'SMS', type: 'Lab results ready', message: 'Your recent lab results have been reviewed. See your visit at 15:00.', time: 'Yesterday', status: 'Delivered', tone: 'success' },
];

export const messageTemplates = [
  { name: 'Appointment reminder', channel: 'SMS', usage: '412 sends this month', status: 'Active' },
  { name: 'Recall annual review due', channel: 'WhatsApp', usage: '96 sends this month', status: 'Active' },
  { name: 'Balance overdue notice', channel: 'Email', usage: '38 sends this month', status: 'Active' },
  { name: 'Post-visit satisfaction survey', channel: 'SMS', usage: '187 sends this month', status: 'Paused' },
];

export const reminderCampaigns = [
  { name: 'No show prevention sweep', audience: '24 patients today', progress: 78, detail: '19 confirmed · 3 pending · 2 unreachable', tone: 'success' },
  { name: 'Hypertension recall', audience: '41 patients this month', progress: 55, detail: '23 booked from recall messages', tone: 'warm' },
  { name: 'Overdue balance outreach', audience: '18 accounts', progress: 40, detail: 'USD 220 recovered so far', tone: 'neutral' },
];

// Claim lifecycle against the NH263 biometric claims switch.
// Draft → biometric member verification → real-time submission → switch adjudication → remittance.
