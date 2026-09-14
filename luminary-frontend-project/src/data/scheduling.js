// `day` is an offset from today (0 = today), so the week grid has somewhere to
// put a booking made on another day. `duration` is minutes, so an appointment
// occupies real height on the calendar rather than a single row.
export const initialSchedule = [
  { id: 'APT-01', day: 0, duration: 30, time: '09:00', patient: 'Nyasha Chari', type: 'New patient consult', provider: 'Dr. Chen', room: 'Room 1', mode: 'In person' },
  { id: 'APT-02', day: 0, duration: 30, time: '09:45', patient: 'Tawanda Mutsvangwa', type: 'Follow up', provider: 'Dr. Ahmed', room: 'Room 3', mode: 'In person' },
  { id: 'APT-03', day: 0, duration: 30, time: '10:30', patient: 'Ruvimbo Moyo', type: 'Blood pressure review', provider: 'Dr. Chen', room: 'Room 1', mode: 'In person' },
  { id: 'APT-04', day: 0, duration: 45, time: '11:15', patient: 'Chiedza Mutasa', type: 'Cardiology follow up', provider: 'Dr. Park', room: 'Room 2', mode: 'In person' },
  { id: 'APT-05', day: 0, duration: 45, time: '12:15', patient: 'Tariro Gumbo', type: 'Cardiology review', provider: 'Dr. Park', room: 'Room 2', mode: 'In person' },
  { id: 'APT-06', day: 0, duration: 30, time: '14:15', patient: 'Farai Nyamande', type: 'Postoperative check', provider: 'Dr. Chen', room: 'Room 1', mode: 'In person' },
  { id: 'APT-07', day: 0, duration: 30, time: '15:00', patient: 'Kudzai Machingura', type: 'Lab review', provider: 'Dr. Singh', room: 'Room 4', mode: 'Telehealth' },
  { id: 'APT-08', day: 0, duration: 30, time: '16:00', patient: 'Tendai Moyo', type: 'Medication review', provider: 'Dr. Ahmed', room: 'Room 3', mode: 'In person' },
];

export const ROOMS = ['Room 1', 'Room 2', 'Room 3', 'Room 4'];

// Kept in sync with ALL_TABS in PatientFile.jsx and the AI tab list, so the
// router can turn a URL slug back into the tab label.

export const providerNames = ['Dr. Chen', 'Dr. Ahmed', 'Dr. Park', 'Dr. Singh'];

// Single source of truth for status colour, replacing ternaries repeated per module.
