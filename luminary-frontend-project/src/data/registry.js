// One registry drives every module. Appointments, invoices, claims, and the
// clinical queue all reference these people by name — nothing is invented locally.
export const initialPatientRows = [
  { name: 'Nyasha Chari', id: 'PT-6039', practiceId: 'PRC-001', lastVisit: 'Not recorded', next: 'Today 09:00', balance: 0, status: 'New', provider: 'Dr. Chen', memberNo: 'NH263-013874-00' },
  { name: 'Tawanda Mutsvangwa', id: 'PT-3304', practiceId: 'PRC-001', lastVisit: 'Aug 14', next: 'Today 09:45', balance: 115, status: 'Active', provider: 'Dr. Ahmed', memberNo: 'NH263-011302-01' },
  { name: 'Ruvimbo Moyo', id: 'PT-2048', practiceId: 'PRC-001', lastVisit: 'Aug 19', next: 'Today 10:30', balance: 60, status: 'Active', provider: 'Dr. Chen', memberNo: 'NH263-004821-00' },
  { name: 'Chiedza Mutasa', id: 'PT-2210', practiceId: 'PRC-001', lastVisit: 'Aug 20', next: 'Today 11:15', balance: 195, status: 'Overdue', provider: 'Dr. Park', memberNo: 'NH263-006233-00' },
  { name: 'Tariro Gumbo', id: 'PT-1681', practiceId: 'PRC-001', lastVisit: 'Aug 16', next: 'Today 12:15', balance: 75, status: 'Follow-up', provider: 'Dr. Park', memberNo: 'NH263-007754-00' },
  { name: 'Farai Nyamande', id: 'PT-5107', practiceId: 'PRC-001', lastVisit: 'Aug 18', next: 'Today 14:15', balance: 150, status: 'Overdue', provider: 'Dr. Chen', memberNo: 'NH263-010455-00' },
  { name: 'Kudzai Machingura', id: 'PT-4450', practiceId: 'PRC-001', lastVisit: 'Aug 09', next: 'Today 15:00', balance: 40, status: 'Review', provider: 'Dr. Singh', memberNo: 'NH263-009910-02' },
  { name: 'Tendai Moyo', id: 'PT-3388', practiceId: 'PRC-001', lastVisit: 'Aug 21', next: 'Today 16:00', balance: 175, status: 'Overdue', provider: 'Dr. Ahmed', memberNo: 'NH263-012090-00' },

];

// `day` is an offset from today (0 = today), so the week grid has somewhere to
// put a booking made on another day. `duration` is minutes, so an appointment
// occupies real height on the calendar rather than a single row.

// Single source of truth for status colour, replacing ternaries repeated per module.
export const patientStatusTone = {
  Active: 'success',
  'Follow-up': 'warm',
  Review: 'accent',
  Overdue: 'alert',
  New: 'neutral',
};

// scope controls which roles see each metric: finance metrics stay out of clinical views.
// Values are derived from live state at render so the tiles always agree with the tables.
