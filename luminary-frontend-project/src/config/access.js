import {
  CalendarDays, CreditCard, FileText, LayoutGrid, MessageSquare,
  BrainCircuit, ScrollText, ShieldCheck, SlidersHorizontal, Stethoscope, Users, ClipboardList, Table,
  ListChecks,
} from 'lucide-react';

/**
 * Navigation and access, as the interface consumes them.
 *
 * The permission matrix itself lives in `permissions.js`, which imports
 * nothing — this file pulls in icon components, and anything importing icons
 * needs React and a bundler. The server's contract test reads that file
 * directly to prove the two copies of the matrix agree, and it cannot do that
 * through a module that resolves `lucide-react`.
 *
 * Re-exported here so every existing call site keeps working unchanged.
 */
export {
  PERMISSIONS,
  SELF_ELEVATION_BLOCKED,
  roleAccess,
  metricScopeByRole,
} from './permissions';

export const navItems = [
  { id: 'dashboard', label: 'Overview', icon: LayoutGrid },
  { id: 'patients', label: 'Patients', icon: Users },
  { id: 'appointments', label: 'Appointments', icon: CalendarDays },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'billing-handoff', label: 'Billing queue', icon: ListChecks },
  { id: 'clinical', label: 'Clinical', icon: Stethoscope },
  { id: 'orders', label: 'Orders', icon: ClipboardList },
  { id: 'claims', label: 'Claims', icon: ShieldCheck },
  { id: 'tariffs', label: 'Tariffs', icon: Table },
  { id: 'communications', label: 'Communications', icon: MessageSquare },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'ai', label: 'Luminary AI', icon: BrainCircuit },
  { id: 'audit', label: 'Audit log', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
];

// Kept in sync with ALL_TABS in PatientFile.jsx and the AI tab list, so the
// router can turn a URL slug back into the tab label.
export const PATIENT_FILE_TABS = ['Summary', 'Demographics', 'Clinical', 'Episodes', 'Notes', 'Cover & consent', 'Visits', 'Billing', 'Documents'];
