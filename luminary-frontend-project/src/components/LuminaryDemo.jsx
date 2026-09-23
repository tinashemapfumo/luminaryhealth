import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  Moon,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import { LuminaryLogo, LuminaryMark } from './LuminaryLogo';
import { Modal, Field, Input, Select, Textarea, Button, Toast, OceanWaveDecoration, HumanAvatar } from './ui';
import { timeToMinutes } from './ScheduleCalendar';
import { WorkspaceProvider } from '../lib/workspace';
import { usePersistentState, clearAll, storageSummary } from '../lib/persistence';
import ReportsPage from './pages/ReportsPage';
import CommunicationsPage from './pages/CommunicationsPage';
import AuditPage from './pages/AuditPage';
import BillingPage from './pages/BillingPage';
import BillingHandoffPage from './pages/BillingHandoffPage';
import OrdersPage from './pages/OrdersPage';
import TariffImportPage from './pages/TariffImportPage';
import ClaimsPage from './pages/ClaimsPage';
import DashboardPage from './pages/DashboardPage';
import PatientsPage from './pages/PatientsPage';
import AppointmentsPage from './pages/AppointmentsPage';
import ClinicalPage from './pages/ClinicalPage';
import AIPage from './pages/AIPage';
import SettingsPage from './pages/SettingsPage';
import { useHashRoute, navigate, buildHash, parseHash, toSlug, fromSlug } from '../lib/router';
import { initialGrants, AUDIT, RELATIONSHIP, practices as seededPractices, users as seedUsers } from '../data/organisation';
import { defaultSettings, activeRoomNames } from '../data/practiceSettings';
import { initialCatalogue, triggerLabel, BILLING_TRIGGERS } from '../data/catalogue';
import { initialTariffs, initialPayers, planByName } from '../data/tariffs';
import { initialOrders, ORDER_STATUS, orderStatusTone, ORDER_PRIORITIES } from '../data/orders';
import {
  nextOrderStatus, billingDecision, billedKeysFrom, ordersAwaitingBilling,
} from '../lib/orders';
import {
  activeServices as catalogueServices, serviceById, serviceForVisitType, priceOn,
  repriceService,
} from '../lib/catalogue';
import { createTariffProvider, priceLine } from '../lib/tariffs';
import { publishTariffs, rollbackBatch } from '../lib/import/stage';
import { makeAlias } from '../lib/import/profiles';
import {
  patientsInPractice,
  patientsInCare,
  careRelationship,
  chartAccess,
  makeBreakGlassGrant,
} from '../lib/access';
import { initialEncounters, blankNote, NOTE_STATUS } from '../data/encounters';
import {
  initialPatientRecords,
  recordCompleteness,
  ageFromDob,
  SEX_OPTIONS,
  COVER_PLANS,
  RELATIONSHIPS,
  CONTACT_METHODS,
} from '../data/patientRecords';

import { AI_TABS } from '../data/intelligence';
import { PATIENT_FILE_TABS, navItems, roleAccess } from '../config/access';
import { initialSchedule } from '../data/scheduling';
import { StatusPill } from './shared/StatusPill';
import { ReceiptDocument } from './shared/ReceiptDocument';
import { PatientPicker } from './shared/PatientPicker';
import { clinicalQueue, visitStatusFlow } from '../data/clinical';
import { initialClaims, initialInvoices, REJECTION_REASONS } from '../data/billing';
import { initialEpisodes, EPISODE_STATUSES } from '../data/episodes';
import { communicationLog } from '../data/engagement';
import { currencyFor } from '../lib/format';
import {
  checkPayment, buildReceipt, outstandingOn, paidSoFar, format as formatMoney,
  CURRENCIES, PAYMENT_METHODS, ADJUSTMENT_TYPES, adjustmentLabel, checkAdjustment,
  statementFor, checkStatementPayment, daysOverdue, agingBucket, round2, FALLBACK_CURRENCY,
  balanceAfter,
} from '../lib/money';
import { initialPatientRows, patientStatusTone } from '../data/registry';
import { usePatientDirectory, createBodyFromForm, patchFromChanges, documentFromApi, formatBytes } from '../services/patients';
import { api, isLive } from '../services/api';
import { useLiveWorkspaceData, encounterFromApi, invoiceFromApi, settingsFromApi, prescriptionFromApi } from '../services/liveWorkspace';

/** Fallback for a user with no job title recorded. */
const ROLE_LABELS = {
  admin: 'Administrator',
  doctor: 'Doctor',
  nurse: 'Nurse',
  manager: 'Practice manager',
  receptionist: 'Receptionist',
};

const EMPTY_PATIENT = {
  id: 'No patient',
  patientId: null,
  practiceId: null,
  name: 'No patient selected',
  lastVisit: 'Not recorded',
  next: 'Not scheduled',
  balance: 0,
  status: 'New',
  provider: 'Unassigned',
  memberNo: '',
  coverPlan: 'Self-pay',
};

const liveSettingsShell = (practice) => ({
  profile: {
    name: practice.name || '',
    short: practice.short || '',
    addressLine: '',
    city: practice.location || '',
    phone: '',
    email: '',
    primaryCurrency: 'USD',
    secondaryCurrency: '',
    usdRate: '',
  },
  providers: [],
  rooms: [],
  hours: {
    opensAt: '08:00',
    closesAt: '17:00',
    slotMinutes: '15',
    openDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  },
  schemes: [],
  services: [],
  integrations: {
    nh263ProviderNumber: '',
    nh263Endpoint: '',
    nh263Connected: false,
    smsSender: '',
    smsGateway: '',
    smsConnected: false,
  },
  security: {
    idleTimeoutMinutes: '15',
    minimumPasswordLength: 12,
    breakGlassEnabled: true,
    breakGlassRequiresReason: true,
    enforceRegistrationExpiry: true,
  },
});

const PRICING_MODES = ['Standard price', 'Adjust standard price', 'Custom price'];
const PRICE_OVERRIDE_REASONS = [
  'Consumables used',
  'Procedure complexity',
  'Extended consultation',
  'After-hours',
  'Provider discretion',
  'Contracted client rate',
  'Other',
];

function EpisodeLinkPicker({ title, items, selected = [], onToggle, empty }) {
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">{title}</p>
      {items.length ? (
        <div className="mt-2 space-y-2">
          {items.map((item) => (
            <label key={item.id} className="flex items-start gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={() => onToggle(item.id)}
                className="mt-0.5 h-4 w-4 accent-brand"
              />
              <span>
                <span className="font-medium text-ink">{item.label}</span>
                {item.detail && <span className="block text-xs text-muted">{item.detail}</span>}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      )}
    </div>
  );
}

const LuminaryPMSDemo = ({ session, onSignOut, onLock, onSwitchPractice, auditLog: seedAuditLog = [], recordAudit = () => {} }) => {
  const currentUser = session.user;
  const practice = session.practice;
  const [activeView, setActiveView] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = usePersistentState('theme', 'light');
  const darkMode = theme === 'dark';

  // Transient confirmation so actions have visible consequence.
  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('lh-dark', darkMode);
    document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';

    return () => {
      document.body.classList.remove('lh-dark');
      document.documentElement.style.colorScheme = 'light';
    };
  }, [darkMode]);

  /**
   * The patient registry, from the API when one is configured and from the seed
   * otherwise. Every other collection in this shell is filtered by the names in
   * here, so this single switch carries the whole workspace across.
   *
   * Both are held: the seeded pair stays mounted so demo mode keeps its
   * write-through persistence, and live mode simply reads the other one. The
   * alternative — one collection that changes meaning by mode — makes every
   * reader below responsible for knowing which it has.
   */
  const [seedRows, setSeedRows] = usePersistentState('patients', initialPatientRows);
  const [seedRecords, setSeedRecords] = usePersistentState('patientRecords', initialPatientRecords);
  const announceNewPatients = useCallback((count) => {
    notify(`${count} new patient${count === 1 ? '' : 's'} added to the practice`);
  }, [notify]);
  const patientDirectory = usePatientDirectory({
    practiceId: currentUser.practiceId,
    seedRows,
    seedRecords,
    onError: notify,
    onPatientsAdded: announceNewPatients,
  });
  const live = patientDirectory.live;
  const liveWorkspace = useLiveWorkspaceData({ enabled: live, onError: notify });
  const auditLog = live ? liveWorkspace.auditLog : seedAuditLog;
  const patientRows = live ? patientDirectory.rows : seedRows;
  const setPatientRows = live ? patientDirectory.setRows : setSeedRows;
  const patientRecords = live ? patientDirectory.records : seedRecords;
  const setPatientRecords = live ? patientDirectory.setRecords : setSeedRecords;

  const [fileOpen, setFileOpen] = useState(false);
  const [seedSchedule, setSeedSchedule] = usePersistentState('appointments', initialSchedule);
  const [seedInvoices, setSeedInvoices] = usePersistentState('invoices', initialInvoices);
  const mockSchedule = live ? liveWorkspace.appointments : seedSchedule;
  const setMockSchedule = live ? liveWorkspace.setAppointments : setSeedSchedule;
  const invoiceData = live ? liveWorkspace.invoices : seedInvoices;
  const setInvoiceData = live ? liveWorkspace.setInvoices : setSeedInvoices;
  const [selectedPatientId, setSelectedPatientId] = useState(() =>
    isLive() ? null : (initialPatientRows.find((p) => p.practiceId === currentUser.practiceId) || initialPatientRows[0]).id
  );
  // Fall back within the signed-in user's practice, never to row zero — which
  // could belong to another tenant entirely.
  const selectedPatient =
    patientRows.find((p) => p.id === selectedPatientId) ||
    patientRows.find((p) => p.practiceId === currentUser.practiceId) ||
    patientRows[0] ||
    EMPTY_PATIENT;
  const setSelectedPatient = (patient) => setSelectedPatientId(patient.id);
  const [patientTab, setPatientTab] = useState('Overview');
  // Selections are held as ids and resolved against the practice's own
  // collections further down, once those exist. Seeding them with
  // `initialSchedule[0]` and `initialInvoices[0]` pinned every user to the same
  // records. Null means "nothing chosen yet"; the resolver picks the first
  // record this user is actually entitled to see.
  const [selectedAppointmentId, setSelectedAppointmentId] = useState(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [patientSearch, setPatientSearch] = useState('');
  const [sortKey, setSortKey] = useState({ column: 'registeredAt', direction: 'desc' });
  const [visitStatuses, setVisitStatuses] = useState(() =>
    Object.fromEntries(initialSchedule.map((item) => [item.patient, 'Booked']))
  );

  useEffect(() => {
    if (!live) return;
    setVisitStatuses(Object.fromEntries(mockSchedule.map((item) => [item.patient, item.status || 'Booked'])));
  }, [live, mockSchedule]);

  // Which dialog is open, if any. One slot — dialogs never stack.
  const [dialog, setDialog] = useState(null);
  // The last receipt taken, shown until the next action replaces it. A receipt
  // is a record of a specific moment, so it is never re-derived from the invoice.
  const [receipt, setReceipt] = useState(null);

  /**
   * Receipt numbering.
   *
   * Sequential and persisted, because a receipt number is what ties the slip in
   * the patient's hand to the day book. Kept apart from the payment id: a
   * payment can be reversed, and the reversal is its own entry, but the receipt
   * that was handed over still exists and still has to be findable.
   */
  const [receiptSequence, setReceiptSequence] = usePersistentState('receiptSequence', 1);

  /**
   * Every receipt ever issued, kept.
   *
   * The receipt used to live in `useState` and exist only until the next
   * action: dismiss it, click away, or refresh, and the only record of what
   * the patient was handed was gone. Patients lose receipts and come back for
   * a copy — that is the ordinary case, not an edge one — and the receipt
   * number printed on the slip is exactly what they quote when they do.
   *
   * Held as a list rather than keyed by payment, because one tender against an
   * account creates several payment rows and all of them belong to the single
   * slip that was printed.
   */
  const [receiptLog, setReceiptLog] = usePersistentState('receipts', []);

  const fileReceipt = (issued, paymentIds) => {
    const stored = { ...issued, paymentIds };
    setReceiptLog((prev) => [stored, ...prev]);
    setReceipt(stored);
    return stored;
  };
  const nextReceiptNumber = () => {
    const next = receiptSequence;
    setReceiptSequence(next + 1);
    return `RCT-${new Date().getFullYear()}-${String(next).padStart(4, '0')}`;
  };

  /**
   * Send the receipt — and only the receipt — to the printer.
   *
   * The body class is what the print stylesheet keys off, so `Ctrl+P` anywhere
   * else still prints that page normally. Cleared as soon as `print()` returns
   * and again on `afterprint`, because the two do not fire in the same order in
   * every browser and a workspace left permanently hidden would be a far worse
   * bug than a receipt printed twice.
   */
  const printReceipt = () => {
    const done = () => document.body.classList.remove('lh-printing-receipt');
    window.addEventListener('afterprint', done, { once: true });
    document.body.classList.add('lh-printing-receipt');
    try {
      window.print();
    } finally {
      done();
    }
  };
  const [form, setForm] = useState({});
  const [formErrors, setFormErrors] = useState({});
  const openDialog = (name, initial = {}) => {
    setForm(initial);
    setFormErrors({});
    setDialog(name);
  };
  const closeDialog = () => setDialog(null);
  const setField = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  /**
   * Set a field from a plain value.
   *
   * `setField` reads `event.target.value`, which suits a native control and
   * suits nothing else. Controls that hand back the value itself — the patient
   * picker — use this rather than being made to fabricate an event shaped like
   * a DOM one just to satisfy the setter.
   */
  const setValue = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  const toggleFormList = (key, value) => {
    setForm((prev) => {
      const current = prev[key] || [];
      return {
        ...prev,
        [key]: current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value],
      };
    });
  };


  const [patientFileTab, setPatientFileTab] = useState('Summary');
  const [showPermissions, setShowPermissions] = useState(false);

  // Only today's bookings feed the dashboard, clinical queue, and metrics.
  // Defined once the practice scope exists — see the tenant-scoping block below.

  /** Two appointments clash if they share a resource and overlap in time. */
  const findConflict = (candidate, ignoreId) =>
    mockSchedule.find((other) => {
      if (other.id === ignoreId) return false;
      if ((other.day ?? 0) !== (candidate.day ?? 0)) return false;
      if (other.provider !== candidate.provider && other.room !== candidate.room) return false;
      const aStart = timeToMinutes(candidate.time);
      const aEnd = aStart + (candidate.duration || 30);
      const bStart = timeToMinutes(other.time);
      const bEnd = bStart + (other.duration || 30);
      return aStart < bEnd && aEnd > bStart;
    });

  /** Reschedule by drag. Rejected moves leave the calendar untouched. */
  const startsAtFor = ({ day = 0, time }) => {
    const [hours, minutes] = String(time || '09:00').split(':').map((part) => Number(part));
    const value = new Date();
    value.setDate(value.getDate() + Number(day || 0));
    value.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
    return value.toISOString();
  };

  const moveAppointment = async (appointmentId, target) => {
    const current = mockSchedule.find((a) => a.id === appointmentId);
    if (!current) return;
    const candidate = { ...current, ...target };
    if (candidate.time === current.time && candidate.provider === current.provider
      && candidate.room === current.room && (candidate.day ?? 0) === (current.day ?? 0)) return;

    if (live) {
      try {
        await api.appointments.move(appointmentId, {
          startsAt: startsAtFor(candidate),
          durationMin: candidate.duration || 30,
          providerId: candidate.providerId || current.providerId,
        });
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        notify(`${candidate.patient} moved to ${candidate.time}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const clash = findConflict(candidate, appointmentId);
    if (clash) {
      notify(`Cannot move: ${clash.provider === candidate.provider ? clash.provider : clash.room} already has ${clash.patient} at ${clash.time}`);
      return;
    }

    setMockSchedule((prev) =>
      prev.map((a) => (a.id === appointmentId ? candidate : a)).sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
    );
    setSelectedAppointment(candidate);
    setPatientRows((prev) =>
      prev.map((p) => (p.name === candidate.patient && (candidate.day ?? 0) === 0 ? { ...p, next: `Today ${candidate.time}` } : p))
    );
    notify(`${candidate.patient} moved to ${candidate.time}${candidate.provider !== current.provider ? ` with ${candidate.provider}` : ''}`);
  };
  const [seedEncounters, setSeedEncounters] = usePersistentState('encounters', initialEncounters);
  const [liveEncounters, setLiveEncounters] = useState([]);
  const encounters = live ? liveEncounters : seedEncounters;
  const setEncounters = live ? setLiveEncounters : setSeedEncounters;
  const [episodes, setEpisodes] = usePersistentState('episodes', initialEpisodes);
  const [openNoteId, setOpenNoteId] = useState(null);
  const openNote = encounters.find((note) => note.id === openNoteId) || null;

  const notesForPatient = (patientId) => encounters.filter((note) => note.patientId === patientId);
  const attachToOpenEpisode = (patient, links) => {
    if (!patient) return;
    setEpisodes((prev) => {
      const target = prev.find((episode) =>
        (episode.patientId === patient.id || episode.patientName === patient.name)
        && ['Active', 'Chronic', 'Referred'].includes(episode.status)
      );
      if (!target) return prev;
      return prev.map((episode) => {
        if (episode.id !== target.id) return episode;
        const next = { ...episode };
        Object.entries(links).forEach(([key, value]) => {
          if (!value) return;
          const current = next[key] || [];
          next[key] = current.includes(value) ? current : [...current, value];
        });
        return next;
      });
    });
  };

  /** Open the note for a visit, creating a draft if none exists yet. */
  const noteBodyForApi = (note) => ({
    note_type: note.type,
    subjective: note.subjective,
    objective: note.objective,
    assessment: note.assessment,
    plan: note.plan,
    follow_up: note.followUp,
    diagnoses: note.diagnoses ?? [],
  });

  const openNoteForVisit = async (patient, appointment) => {
    const existing = encounters.find(
      (note) => note.patientId === patient.id && note.status === NOTE_STATUS.DRAFT
    );
    if (existing) {
      setOpenNoteId(existing.id);
    } else {
      if (live) {
        try {
          const created = await api.encounters.createDraft({
            patientId: patient.patientId ?? patient.id,
            appointmentId: appointment?.id,
            noteType: 'SOAP note',
          });
          const note = encounterFromApi(created, patient);
          setLiveEncounters((prev) => [note, ...prev]);
          setOpenNoteId(note.id);
          attachToOpenEpisode(patient, { linkedNoteIds: note.id, linkedVisitIds: appointment?.id });
        } catch (error) {
          notify(error.message);
          return;
        }
      } else {
      const created = blankNote({
        patientId: patient.id,
        patientName: patient.name,
        provider: appointment?.provider || patient.provider,
        appointmentTime: appointment?.time,
      });
      setEncounters((prev) => [created, ...prev]);
      setOpenNoteId(created.id);
      attachToOpenEpisode(patient, { linkedNoteIds: created.id, linkedVisitIds: appointment?.id });
      }
    }
    setSelectedPatientId(patient.id);
  };

  const saveNote = async (updated) => {
    if (live) {
      try {
        const saved = await api.encounters.saveDraft(updated.id, noteBodyForApi(updated));
        setLiveEncounters((prev) => prev.map((note) => (
          note.id === updated.id ? encounterFromApi(saved, { id: updated.patientId, name: updated.patientName }) : note
        )));
        notify('Draft saved');
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    setEncounters((prev) => prev.map((note) => (note.id === updated.id ? updated : note)));
    notify('Draft saved');
  };

  const applyDictationEncounter = (encounter, currentNote) => {
    const mapped = encounterFromApi(encounter, {
      id: currentNote.patientId,
      name: currentNote.patientName,
    });
    setLiveEncounters((prev) => prev.map((note) => (note.id === mapped.id ? mapped : note)));
    return mapped;
  };

  const completeTriage = async (note) => {
    if (live) {
      try {
        const completed = await api.encounters.completeTriage(note.id);
        setLiveEncounters((prev) => prev.map((item) => (
          item.id === note.id ? encounterFromApi(completed, { id: note.patientId, name: note.patientName }) : item
        )));
        await liveWorkspace.reload();
        notify(`Triage complete for ${note.patientName}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    setEncounters((prev) => prev.map((item) => (
      item.id === note.id ? { ...item, triageCompletedAt: stamp, triageCompletedBy: roleInfo.person } : item
    )));
    setVisitStatuses((prev) => ({ ...prev, [note.patientName]: 'Ready for provider' }));
    notify(`Triage complete for ${note.patientName}`);
  };

  const submitEpisode = (event) => {
    event.preventDefault();
    const errors = {};
    if (!form.patientId) errors.patient = 'Open a patient file first';
    if (!form.title?.trim()) errors.title = 'Episode title is required';
    if (!form.startDate?.trim()) errors.startDate = 'Start date is required';
    if (!form.primaryDiagnosis?.trim()) errors.primaryDiagnosis = 'Primary diagnosis is required';
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const patient = practicePatients.find((item) => item.id === form.patientId || item.name === form.patientName);
    const episode = {
      id: form.id || `EPI-${form.patientId}-${Date.now().toString(36).toUpperCase()}`,
      patientId: form.patientId,
      patientName: form.patientName || patient?.name || 'Unknown patient',
      title: form.title.trim(),
      reason: form.reason?.trim() || '',
      startDate: form.startDate,
      primaryDiagnosis: form.primaryDiagnosis.trim(),
      status: form.status || 'Active',
      linkedVisitIds: form.linkedVisitIds || [],
      linkedNoteIds: form.linkedNoteIds || [],
      linkedOrderIds: form.linkedOrderIds || [],
      linkedInvoiceIds: form.linkedInvoiceIds || [],
      linkedClaimIds: form.linkedClaimIds || [],
      outcome: form.outcome?.trim() || '',
    };

    setEpisodes((prev) => (form.id
      ? prev.map((item) => (item.id === form.id ? episode : item))
      : [episode, ...prev]));
    closeDialog();
    notify(`${episode.title} episode ${form.id ? 'updated' : 'started'} for ${episode.patientName}`);
  };

  const updateEpisode = (episodeId, patch) => {
    setEpisodes((prev) => prev.map((episode) => (
      episode.id === episodeId ? { ...episode, ...patch } : episode
    )));
  };

  const signNote = async (updated) => {
    if (live) {
      try {
        await api.encounters.saveDraft(updated.id, noteBodyForApi(updated));
        const signed = await api.encounters.sign(updated.id);
        setLiveEncounters((prev) => prev.map((note) => (
          note.id === updated.id ? encounterFromApi(signed, { id: updated.patientId, name: updated.patientName }) : note
        )));
        await liveWorkspace.reload();
        notify(`Note signed for ${updated.patientName}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    setEncounters((prev) =>
      prev.map((note) =>
        note.id === updated.id
          ? { ...updated, status: NOTE_STATUS.SIGNED, signedBy: roleInfo.person, signedAt: stamp }
          : note
      )
    );

    /*
     * Carry the diagnosis onto any claim still waiting for one.
     *
     * The order of a real day is: bill at the desk while the patient is there,
     * sign the note afterwards. So the claim is usually raised before the
     * diagnosis exists, and someone had to remember to go back and put it on.
     * Nobody remembers. This closes that loop the moment the note is signed.
     *
     * Only claims that are still uncoded and still in Draft are touched: once a
     * claim has been submitted to the switch, its diagnosis is part of what was
     * transmitted, and quietly editing it afterwards would make the record
     * disagree with what NH263 was actually told.
     */
    const coded = (updated.diagnoses ?? []).map((d) => `${d.code}, ${d.label}`).join(' · ');
    if (coded) {
      let touched = 0;
      setClaims((prev) => prev.map((claim) => {
        if (claim.patient !== updated.patientName) return claim;
        if (claim.status !== 'Draft' || claim.icd10 !== 'Not coded') return claim;
        touched += 1;
        return {
          ...claim,
          icd10: coded,
          responses: [
            ...claim.responses,
            { label: `Diagnosis coded from signed note · ${coded}`, time: 'Just now', tone: 'neutral' },
          ],
        };
      }));
      if (touched > 0) {
        notify(`Note signed for ${updated.patientName} · diagnosis added to ${touched} draft claim${touched === 1 ? '' : 's'}`);
        return;
      }
    }

    notify(`Note signed for ${updated.patientName}`);
  };

  const addAddendum = async (noteId, text) => {
    if (live) {
      try {
        await api.encounters.addendum(noteId, { body: text });
        const note = encounters.find((item) => item.id === noteId);
        if (note?.patientApiId) {
          const rows = await api.encounters.list(note.patientApiId);
          setLiveEncounters((prev) => [
            ...prev.filter((item) => item.patientId !== note.patientId),
            ...rows.map((row) => encounterFromApi(row, { id: note.patientId, name: note.patientName })),
          ]);
        }
        notify('Addendum appended');
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    setEncounters((prev) =>
      prev.map((note) =>
        note.id === noteId
          ? { ...note, status: NOTE_STATUS.AMENDED, addenda: [...note.addenda, { text, by: roleInfo.person, at: stamp }] }
          : note
      )
    );
    notify('Addendum appended');
  };

  const openPatientFile = (patient) => {
    setSelectedPatientId(patient.id);
    setFileOpen(true);
    setActiveView('patients');
    // Each chart opens fresh — otherwise whichever tab was last viewed on a
    // previous patient (e.g. Clinical) silently carries over to the next one.
    setPatientFileTab('Summary');
  };

  /**
   * Persist edits from the patient file, keeping the registry row in step.
   *
   * In live mode only the changed fields are sent: the server permissions
   * updates field group by field group, so posting the whole record back would
   * be refused for groups the caller cannot write even where nothing in them
   * changed. The local copy is updated after the server accepts, not before —
   * an optimistic write that the server then rejects leaves the screen showing
   * a chart edit that does not exist.
   */
  const savePatientRecord = async (updated) => {
    if (live) {
      const patch = patchFromChanges(patientRecords[updated.id], updated);
      if (patch.coverPlan !== undefined) {
        delete patch.coverPlan;
        const scheme = (settings.schemes || []).find((item) => item.name === updated.coverPlan);
        if (updated.coverPlan === 'Self-pay' || !updated.coverPlan) {
          patch.schemeId = null;
        } else if (scheme?.id) {
          patch.schemeId = scheme.id;
        } else {
          notify('Choose a configured medical aid scheme before saving cover');
          return;
        }
      }
      if (Object.keys(patch).length === 0) {
        notify('No changes to save');
        return;
      }
      try {
        await api.patients.update(updated.patientId ?? updated.id, patch);
        await patientDirectory.reload();
      } catch (error) {
        notify(error.message);
        return;
      }
    }

    setPatientRecords((prev) => ({ ...prev, [updated.id]: updated }));
    setPatientRows((prev) =>
      prev.map((row) => (row.id === updated.id ? { ...row, name: updated.name, memberNo: updated.memberNo } : row))
    );
    const { percent } = recordCompleteness(updated);
    notify(percent === 100 ? `${updated.name}'s record saved, file complete` : `${updated.name}'s record saved, ${percent}% complete`);
  };

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('That file could not be read'));
      reader.readAsDataURL(file);
    });

  const uploadPatientDocument = async ({ patient, file, kind, notes }) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/dicom'];
    if (!file) return;
    if (!allowed.includes(file.type || '')) {
      notify('Upload a PDF, JPEG, PNG, WebP, or DICOM file');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      notify('Clinical documents must be 25 MB or smaller');
      return;
    }

    if (live) {
      try {
        const dataBase64 = await fileToBase64(file);
        const doc = await api.documents.upload(patient.patientId ?? patient.id, {
          kind,
          filename: file.name,
          contentType: file.type,
          byteSize: file.size,
          dataBase64,
          notes,
        });
        const mapped = documentFromApi(doc);
        setPatientRecords((prev) => ({
          ...prev,
          [patient.id]: {
            ...prev[patient.id],
            documents: [mapped, ...(prev[patient.id]?.documents ?? [])],
          },
        }));
        notify(`${file.name} uploaded to client files`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const added = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    setPatientRecords((prev) => ({
      ...prev,
      [patient.id]: {
        ...prev[patient.id],
        documents: [
          {
            id: `DOC-${Date.now()}`,
            name: file.name,
            kind,
            added,
            size: formatBytes(file.size),
            notes,
          },
          ...(prev[patient.id]?.documents ?? []),
        ],
      },
    }));
    notify(`${file.name} indexed locally`);
  };

  /**
   * Issue a prescription for the currently open patient.
   *
   * `allergiesReviewed` is sent as the caller's acknowledgement, but the
   * server remains the authority: an unreviewed-allergy 409 is rethrown so
   * the modal can show the review step rather than a generic error.
   */
  const createPrescription = async ({ patient, allergiesReviewed, ...fields }) => {
    if (!live) {
      notify('Prescriptions require the live API');
      return null;
    }
    const durationDays = fields.durationDays !== undefined && fields.durationDays !== ''
      ? Number(fields.durationDays) : undefined;
    const quantity = fields.quantity !== undefined && fields.quantity !== ''
      ? Number(fields.quantity) : undefined;
    const refills = fields.refills !== undefined && fields.refills !== ''
      ? Number(fields.refills) : 0;
    const rx = await api.prescriptions.create({
      patientId: patient.patientId ?? patient.id,
      encounterId: fields.encounterId || null,
      drug: fields.drug?.trim(),
      form: fields.form?.trim() || undefined,
      strength: fields.strength?.trim() || undefined,
      dose: fields.dose?.trim() || undefined,
      route: fields.route?.trim() || undefined,
      frequency: fields.frequency?.trim() || undefined,
      durationDays,
      quantity,
      refills,
      indication: fields.indication?.trim() || undefined,
      pharmacy: fields.pharmacy?.trim() || undefined,
      substitutionAllowed: fields.substitutionAllowed,
      instructions: fields.instructions?.trim() || undefined,
      allergiesReviewed: Boolean(allergiesReviewed),
    });
    const mapped = prescriptionFromApi(rx, roleInfo.person ?? currentUser.name);
    setPatientRecords((prev) => ({
      ...prev,
      [patient.id]: {
        ...prev[patient.id],
        prescriptions: [mapped, ...(prev[patient.id]?.prescriptions ?? [])],
      },
    }));
    return mapped;
  };

  const mergePatients = async ({ sourcePatientId, survivorPatientId, reason }) => {
    if (!live) {
      notify('Patient merge requires the live API');
      return;
    }
    try {
      const result = await api.patients.merge({ sourcePatientId, survivorPatientId, reason });
      await patientDirectory.reload();
      setSelectedPatientId(result.survivorPatientId || survivorPatientId);
      notify(result.status === 'already_merged' ? 'Patient was already merged' : 'Patient records merged');
      return result;
    } catch (error) {
      notify(error.message);
      throw error;
    }
  };

  const downloadPatientDocument = async (doc) => {
    if (!live || !doc.live) {
      notify(`${doc.name} is indexed locally; no stored binary exists in demo mode`);
      return;
    }
    try {
      const { blob, filename } = await api.documents.download(doc.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      notify(`${filename} downloaded`);
    } catch (error) {
      notify(error.message);
    }
  };

  const exportPatientFile = async (patient, options) => {
    const patientId = patient.patientId || patient.id;
    const job = await api.patientExports.request(patientId, options);
    notify('Patient export queued');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const current = await api.patientExports.status(job.id);
      if (current.status === 'failed') throw new Error('Patient export generation failed');
      if (current.status === 'revoked' || current.status === 'expired') throw new Error(`Patient export is ${current.status}`);
      if (current.status !== 'ready') continue;
      const { blob, filename } = await api.patientExports.download(job.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      notify(`${filename} downloaded`);
      return;
    }
    throw new Error('Patient export is still processing');
  };

  const submitNewPatient = async (event) => {
    event.preventDefault();
    const errors = {};
    if (!form.name?.trim()) errors.name = 'Patient name is required';
    else if (!form.name.trim().includes(' ')) errors.name = 'Enter both first and last name';
    if (!form.dob) errors.dob = 'Date of birth is required';
    else if (new Date(form.dob) > new Date()) errors.dob = 'Date of birth cannot be in the future';
    if (!form.sex) errors.sex = 'Sex is required';
    if (!form.phone?.trim()) errors.phone = 'A contact number is required';
    if (!form.addressCity?.trim()) errors.addressCity = 'City is required';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.email = 'Enter a valid email address';
    if (!form.emergencyName?.trim()) errors.emergencyName = 'An emergency contact is required';
    if (!form.emergencyPhone?.trim()) errors.emergencyPhone = 'An emergency number is required';
    else if (form.emergencyPhone.trim() === form.phone?.trim()) errors.emergencyPhone = 'Must differ from the patient’s own number';
    if (form.coverPlan !== 'Self-pay' && !form.memberNo?.trim()) errors.memberNo = 'Member number is required for medical aid cover';
    if (!form.consentTreatment) errors.consentTreatment = 'Consent to treat must be captured before registration';
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const id = `PT-${Math.floor(1000 + patientRows.length * 137 + form.name.length * 29)}`;

    // Live mode registers against the server and lets it own the record. The
    // seeded branch below is what runs with no API configured; it is not a
    // fallback for a failed request, which stops here with the reason.
    if (live) {
      try {
        const created = await api.patients.create(createBodyFromForm(form, { reference: id }));
        await patientDirectory.reload();
        setSelectedPatientId(created.reference || created.id);
        setActiveView('patients');
        setFileOpen(true);
        closeDialog();
        notify(`${form.name.trim()} registered, complete the clinical intake`);
      } catch (error) {
        // Field-level messages from the server land on the fields themselves,
        // so a rejected registration is correctable in place rather than a
        // banner the user has to translate back into a form.
        const fields = {};
        (error.details || []).forEach((detail) => {
          const key = { fullName: 'name', dateOfBirth: 'dob', emergencyRelation: 'emergencyRelationship', memberNumber: 'memberNo', addressCity: 'addressCity' }[detail.field] || detail.field;
          fields[key] = detail.message;
        });
        setFormErrors(Object.keys(fields).length ? fields : {});
        if (error.status === 409 && error.details?.kind === 'probable_duplicate') {
          const names = (error.details.candidates || [])
            .map((candidate) => `${candidate.fullName} (${candidate.reference})`)
            .join(', ');
          const proceed = window.confirm(`Possible duplicate patient found: ${names}. Create a separate patient anyway?`);
          if (proceed) {
            const created = await api.patients.create(createBodyFromForm(form, {
              reference: id,
              duplicateAcknowledged: true,
            }));
            await patientDirectory.reload();
            setSelectedPatientId(created.reference || created.id);
            setActiveView('patients');
            setFileOpen(true);
            closeDialog();
            notify(`${form.name.trim()} registered after duplicate acknowledgement`);
            return;
          }
        }
        notify(error.message);
      }
      return;
    }
    const row = {
      name: form.name.trim(),
      id,
      lastVisit: 'Not recorded',
      next: 'Not scheduled',
      balance: 0,
      status: 'New',
      provider: form.provider || defaultProviderName,
      memberNo: form.memberNo?.trim() || 'Self-pay',
    };

    setPatientRows((prev) => [row, ...prev]);
    setPatientRecords((prev) => ({
      ...prev,
      [id]: {
        id,
        name: row.name,
        preferredName: '',
        dob: form.dob,
        sex: form.sex,
        nationalId: form.nationalId?.trim() || '',
        maritalStatus: 'Not stated',
        occupation: form.occupation?.trim() || '',
        language: form.language || 'English',
        phone: form.phone.trim(),
        altPhone: '',
        email: form.email?.trim() || '',
        addressStreet: form.addressStreet?.trim() || '',
        addressSuburb: form.addressSuburb?.trim() || '',
        addressCity: form.addressCity.trim(),
        addressCountry: 'Zimbabwe',
        preferredContact: form.preferredContact || 'SMS',
        emergencyName: form.emergencyName.trim(),
        emergencyRelationship: form.emergencyRelationship || 'Other',
        emergencyPhone: form.emergencyPhone.trim(),
        coverPlan: form.coverPlan || 'NH263 Plan A',
        memberNo: row.memberNo,
        principalMember: form.principalMember?.trim() || row.name,
        dependantCode: form.dependantCode?.trim() || '00',
        coverValidUntil: '',
        coverStatus: form.coverPlan === 'Self-pay' ? 'Self-pay' : 'Active',
        bloodType: form.bloodType || '',
        allergiesRecorded: false,
        allergies: [],
        conditions: [],
        medications: [],
        familyHistory: [],
        smoking: 'Not recorded',
        alcohol: 'Not recorded',
        exercise: '',
        immunisations: [],
        risk: 'Not assessed',
        registered: new Date().toISOString().slice(0, 10),
        consentTreatment: !!form.consentTreatment,
        consentComms: !!form.consentComms,
        consentDataSharing: !!form.consentDataSharing,
        notes: 'Registered at reception. Clinical intake outstanding: allergies, blood type, and history still to be captured.',
        timeline: [{ label: 'Registered', date: 'Today', detail: 'Demographics and cover captured', tone: 'neutral' }],
        documents: [],
      },
    }));

    setSelectedPatientId(id);
    setActiveView('patients');
    setFileOpen(true);
    closeDialog();
    notify(`${row.name} registered, complete the clinical intake`);
  };

  const submitAppointment = async (event) => {
    event.preventDefault();
    const errors = {};
    const origin = form.origin || 'scheduled';
    if (!form.patient) errors.patient = 'Select a patient';
    if (origin === 'scheduled' && !form.time?.trim()) errors.time = 'A time is required';

    const appointment = {
      id: `APT-${Date.now().toString(36).toUpperCase()}`,
      day: Number(form.day ?? 0),
      duration: Number(form.duration) || 30,
      time: origin === 'walk_in' ? new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : form.time,
      patient: form.patient,
      type: form.type?.trim() || (origin === 'walk_in' ? 'Walk-in' : 'Consultation'),
      provider: origin === 'walk_in' ? 'Unassigned' : (form.provider || defaultProviderName),
      room: form.room || defaultRoomName,
      mode: form.mode || 'In-person',
      origin,
    };

    // Same conflict rule the calendar uses for drag-to-reschedule.
    if (!errors.time && origin === 'scheduled' && form.time) {
      const clash = findConflict(appointment, null);
      if (clash) {
        errors.time = clash.provider === appointment.provider
          ? `${clash.provider} is with ${clash.patient} at ${clash.time}`
          : `${clash.room} is occupied by ${clash.patient} at ${clash.time}`;
      }
    }
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    if (live) {
      const patient = practicePatients.find((p) => p.name === appointment.patient);
      const providerId = origin === 'walk_in' ? null : providerIdForName(appointment.provider);
      if (!patient?.patientId || (origin === 'scheduled' && !providerId)) {
        setFormErrors({
          ...errors,
          ...(patient?.patientId ? {} : { patient: 'Cannot resolve the live patient for this booking.' }),
          ...(origin === 'scheduled' && !providerId ? { provider: 'Select an active provider.' } : {}),
        });
        return;
      }
      try {
        const created = await api.appointments.create({
          patientId: patient.patientId,
          providerId,
          startsAt: origin === 'walk_in' ? null : startsAtFor(appointment),
          durationMin: appointment.duration,
          visitType: appointment.type,
          reason: form.reason?.trim() || appointment.type,
          mode: appointment.mode === 'Telehealth' ? 'telehealth' : 'in_person',
          origin,
        });
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        setSelectedAppointmentId(created.id);
        setActiveView('appointments');
        closeDialog();
        notify(origin === 'walk_in' ? `Walk-in admitted for ${appointment.patient}` : `Visit booked for ${appointment.patient} at ${appointment.time}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    setMockSchedule((prev) => [...prev, appointment].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time)));
    setVisitStatuses((prev) => ({ ...prev, [appointment.patient]: origin === 'walk_in' ? 'Checked in' : 'Booked' }));
    setSelectedAppointment(appointment);
    if (appointment.day === 0) {
      setPatientRows((prev) => prev.map((p) => (p.name === appointment.patient ? { ...p, next: `Today ${appointment.time}` } : p)));
    }
    setActiveView('appointments');
    closeDialog();
    notify(origin === 'walk_in' ? `Walk-in admitted for ${appointment.patient}` : `Visit booked for ${appointment.patient} at ${appointment.time}`);
  };

  /**
   * The diagnosis a claim should carry, taken from the clinician's own note.
   *
   * ICD-10 codes are recorded once, in the encounter, as structured
   * `{ code, label }` pairs — and the claim asked a biller to supply them
   * again from a paper note or from memory. A diagnosis retyped by someone who
   * was not in the room is the single most common reason a scheme rejects a
   * claim it would otherwise have paid.
   *
   * Prefers a signed note: a draft is a clinician still thinking, and its
   * working diagnosis has no business on a reimbursement claim. Returns null
   * rather than a guess when nothing is coded yet, so the claim shows
   * "Not coded" and someone has to look, instead of inheriting a diagnosis
   * from an unrelated visit months ago.
   */
  const diagnosisForClaim = (patientId) => {
    const coded = notesForPatient(patientId)
      .filter((note) => note.status !== NOTE_STATUS.DRAFT && note.diagnoses?.length);
    const latest = coded[0];
    if (!latest) return null;
    return latest.diagnoses.map((d) => `${d.code}, ${d.label}`).join(' · ');
  };

  /**
   * Raise the claim that belongs to an invoice.
   *
   * The server has done this since `createClaimForInvoice` was written; the
   * browser never did, so an invoice raised in the workspace set
   * `claimStatus: 'Draft'` and produced no claim anywhere — the Claims screen
   * only ever showed the five seeded ones and nothing a user did could add to
   * it. Everything below is already known at the moment the invoice exists.
   *
   * Self-pay raises nothing. There is no scheme to claim from, and an empty
   * claim sitting in Draft for ever is worse than no claim at all.
   */
  const raiseClaimForInvoice = (invoice, { patient, coverPlan, service }) => {
    if (coverPlan === 'Self-pay' || !patient?.memberNo) return null;

    // Numbered from the highest reference already issued, not from the count.
    // Counting gives out an id the seed is already using the moment a claim
    // has ever been deleted or the sequence has a gap — and the seed has gaps.
    const highest = claims.reduce((max, existing) => {
      const digits = Number(String(existing.id).replace(/\D/g, '').slice(-4));
      return Number.isNaN(digits) ? max : Math.max(max, digits);
    }, 0);

    const claim = {
      id: `CLM-${new Date().getFullYear()}-${String(highest + 1).padStart(4, '0')}`,
      patient: invoice.patient,
      memberNo: patient.memberNo,
      plan: coverPlan,
      provider: patientRecords[patient.id]?.provider || patient.provider,
      serviceDate: invoice.date,
      amount: formatMoney(invoice.amount, invoice.currency),
      invoice: invoice.id,
      tariff: `${service.code} · ${service.desc}`,
      icd10: diagnosisForClaim(patient.id) ?? 'Not coded',
      status: 'Draft',
      biometric: 'Not captured',
      eligibility: patientRecords[patient.id]?.coverStatus === 'Active'
        ? 'Active · Benefits available'
        : 'Not verified',
      responses: [],
    };
    setClaims((prev) => [claim, ...prev]);
    return claim;
  };

  const submitInvoice = async (event) => {
    event.preventDefault();
    const errors = {};
    const amount = Number(form.amount);
    const pricingMode = form.serviceId ? (form.pricingMode || 'Standard price') : 'Custom price';
    const requiresReason = pricingMode !== 'Standard price';
    if (!form.patient) errors.patient = 'Select a patient';
    if (!form.service?.trim()) errors.service = 'Type the service being billed';
    if (!form.amount || Number.isNaN(amount) || amount <= 0) errors.amount = 'Enter an amount greater than zero';
    if (requiresReason && !form.priceReason) errors.priceReason = 'Choose why this price is different';
    if (requiresReason && form.priceReason === 'Other' && !form.priceNote?.trim()) errors.priceNote = 'Add a note for other price changes';
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const patient = practicePatients.find((p) => p.name === form.patient);
    const coverPlan = coverPlanFor(patient);
    const service = serviceById(catalogue, form.serviceId);

    if (live) {
      if (!patient?.patientId) {
        setFormErrors({ patient: 'Cannot resolve this live patient.' });
        return;
      }
      try {
        const created = await api.billing.createInvoice({
          patientId: patient.patientId,
          currency: billingCurrency,
          dueInDays: 30,
          idempotencyKey: `invoice:${patient.patientId}:${Date.now()}`,
          lines: [{
            code: form.code?.trim() || service?.defaultTariffCode || '99213',
            description: form.service.trim(),
            quantity: 1,
            unitPrice: amount,
            pricingMode,
            priceReason: requiresReason ? form.priceReason : undefined,
            priceNote: requiresReason ? form.priceNote?.trim() : undefined,
            standardUnitPrice: form.standardAmount ? Number(form.standardAmount) : undefined,
          }],
        });
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        setSelectedInvoiceId(created.reference || created.id);
        setActiveView('billing');
        closeDialog();
        notify(`${created.reference || 'Invoice'} raised for ${form.patient}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    /*
     * Price the line.
     *
     * Where a catalogue service was chosen the whole line resolves from it —
     * description, code, practice price, tariff and the estimated split — and
     * the amount on the form is honoured as an override of the practice price
     * only. Where no service was chosen (a one-off charge) the plan's
     * percentage still prices it, which is the fallback that keeps the system
     * usable before every service has been catalogued.
     */
    const priced = service
      ? priceServiceFor({ ...service, price: [{ amount, currency: billingCurrency, effectiveFrom: '2000-01-01', effectiveTo: null }] }, patient)
      : (() => {
        const { plan } = coverFor(patient);
        const funder = plan ? round2(amount * (plan.reimbursePercent / 100)) : 0;
        return {
          serviceId: null,
          code: form.code?.trim() || '99213',
          desc: form.service.trim(),
          quantity: 1,
          unitPrice: amount,
          gross: amount,
          estimatedFunder: funder,
          estimatedPatient: round2(amount - funder),
          tariffVia: plan ? 'plan percentage' : 'no cover',
          tariffId: null,
          actualFunderApproved: null,
          actualFunderPaid: null,
        };
      })();

    const insured = priced.estimatedFunder;
    // Thirty days, as an actual date rather than the words "In 30 days" — the
    // aging report has to subtract it, and a label cannot be subtracted from.
    const issued = new Date();
    const due = new Date(issued);
    due.setDate(due.getDate() + 30);
    const asDay = (d) => d.toISOString().slice(0, 10);
    const asLabel = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

    // `amount`/`insurance` are kept alongside the richer fields because the
    // aging, statement and receipt paths still read them. They are the same
    // numbers, not a second opinion.
    const standardUnitPrice = form.standardAmount ? Number(form.standardAmount) : priced.unitPrice;
    const line = {
      ...priced,
      amount,
      insurance: insured,
      pricingMode,
      standardUnitPrice,
      finalUnitPrice: amount,
      priceChanged: pricingMode !== 'Standard price' || round2(standardUnitPrice) !== round2(amount),
      priceReason: requiresReason ? form.priceReason : null,
      priceNote: requiresReason ? form.priceNote?.trim() || null : null,
      priceCapturedBy: currentUser.name,
      priceCapturedAt: new Date().toISOString(),
    };

    const invoice = {
      id: `INV-2026-${String(15 + invoiceData.length - initialInvoices.length).padStart(3, '0')}`,
      patient: form.patient,
      date: 'Today',
      issuedOn: asDay(issued),
      dueDate: asLabel(due),
      dueOn: asDay(due),
      amount,
      status: 'Pending',
      tone: 'warm',
      claim: 'Not submitted',
      claimStatus: 'Draft',
      services: [line],
      patientResponsibility: amount - insured,
      insurance: coverPlan === 'Self-pay' ? 'Self pay' : `${coverPlan} · ${patient?.memberNo ?? 'No member number'}`,
      currency: billingCurrency,
      // Ties the invoice back to the visit it came from, which is what stops
      // the same consultation being billed a second time.
      ...(form.fromVisit ? { fromVisit: form.fromVisit } : {}),
      payments: [],
      adjustments: [],
    };
    // The claim is raised with the invoice, not later and not by hand, so the
    // two can never describe different money.
    const claim = raiseClaimForInvoice(invoice, { patient, coverPlan, service: line });
    const billed = claim ? { ...invoice, claim: claim.id } : invoice;

    setInvoiceData((prev) => [billed, ...prev]);
    setPatientRows((prev) => prev.map((p) => (p.name === form.patient ? { ...p, balance: p.balance + amount } : p)));
    setSelectedInvoice(billed);
    if (claim) setSelectedClaimId(claim.id);
    attachToOpenEpisode(patient, {
      linkedVisitIds: form.fromVisit,
      linkedInvoiceIds: billed.id,
      linkedClaimIds: claim?.id,
    });
    setActiveView('billing');
    closeDialog();
    notify(claim
      ? `${billed.id} raised for ${billed.patient} · ${claim.id} drafted${claim.icd10 === 'Not coded' ? ', needs a diagnosis' : ''}`
      : `${billed.id} raised for ${billed.patient} · self-pay, no claim`);
  };

  /**
   * Take a payment.
   *
   * Recorded against the invoice in whatever currency the patient actually
   * paid, with the rate used at that moment. Every rule the server enforces is
   * checked here too — not because the client is trusted, but so the desk hears
   * "that is more than the outstanding balance" while the patient is still
   * standing there.
   */
  const submitPayment = async (event) => {
    event.preventDefault();
    const invoice = invoiceData.find((i) => i.id === form.invoiceId) || selectedInvoice;
    const tender = {
      amount: form.amount,
      currency: form.currency || invoice.currency || billingCurrency,
      fxRate: form.fxRate,
    };

    const check = checkPayment(invoice, tender);
    if (!check.ok) {
      setFormErrors({ amount: check.message });
      return;
    }
    setFormErrors({});

    if (live) {
      try {
        const result = await api.billing.recordPayment(invoice.apiId || invoice.id, {
          amount: Number(tender.amount),
          currency: tender.currency,
          fxRate: tender.fxRate ? Number(tender.fxRate) : undefined,
          method: form.method || 'cash',
          idempotencyKey: `payment:${invoice.apiId || invoice.id}:${Date.now()}`,
        });
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        setSelectedInvoiceId(result.invoice?.reference || invoice.id);
        closeDialog();
        notify(`${formatMoney(tender.amount, tender.currency)} received for ${invoice.id}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const payment = {
      id: `PAY-${String(Date.now()).slice(-8)}`,
      amount: Number(tender.amount),
      currency: tender.currency,
      fxRate: check.rate,
      method: form.method || 'cash',
      receivedAt: new Date().toISOString(),
      receivedBy: currentUser.name,
      reversesId: null,
    };

    const payments = [...(invoice.payments || []), payment];
    const remaining = Math.max(0, Math.round((invoice.patientResponsibility - paidSoFar(payments)) * 100) / 100);
    const settled = settleStatus({ ...invoice, payments });

    setInvoiceData((prev) => prev.map((i) => (i.id === invoice.id ? settled : i)));
    // The patient's balance is what they owe, so it falls by what was applied
    // to the invoice — not by what was tendered, which may be another currency.
    setPatientRows((prev) =>
      prev.map((row) => (row.name === invoice.patient ? { ...row, balance: Math.max(0, row.balance - check.applied) } : row))
    );
    setSelectedInvoice(settled);
    fileReceipt(buildReceipt(settled, payment, remaining, nextReceiptNumber()), [payment.id]);
    recordAudit({
      user: currentUser,
      action: 'Recorded payment',
      subject: invoice.id,
      detail: `${formatMoney(payment.amount, payment.currency)} by ${payment.method}`,
      severity: AUDIT.NOTICE,
    });
    closeDialog();
    notify(`${formatMoney(payment.amount, payment.currency)} received for ${invoice.id}`);
  };

  /**
   * Reverse a payment.
   *
   * Written as a counter-entry rather than deleting the original, so the ledger
   * shows both the mistake and the correction. Money that can be quietly
   * un-recorded is money nobody can audit — which is why this needs a reason
   * and lands in the audit log at alert severity.
   */
  const submitReversal = async (event) => {
    event.preventDefault();
    const reason = (form.reason || '').trim();
    if (reason.length < 10) {
      setFormErrors({ reason: 'Give a fuller reason for the reversal.' });
      return;
    }
    setFormErrors({});

    const invoice = invoiceData.find((i) => i.id === form.invoiceId) || selectedInvoice;
    const original = (invoice.payments || []).find((pay) => pay.id === form.paymentId);
    if (!original) return;

    if (live) {
      try {
        await api.billing.reversePayment(original.id, reason);
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        setReceipt(null);
        closeDialog();
        notify(`Payment reversed on ${invoice.id}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const reversal = {
      id: `PAY-${String(Date.now()).slice(-8)}`,
      amount: -original.amount,
      currency: original.currency,
      fxRate: original.fxRate,
      method: original.method,
      receivedAt: new Date().toISOString(),
      receivedBy: currentUser.name,
      reversesId: original.id,
      reason,
    };

    const payments = [...invoice.payments, reversal];
    const updated = settleStatus({ ...invoice, payments });

    setInvoiceData((prev) => prev.map((i) => (i.id === invoice.id ? updated : i)));
    setPatientRows((prev) =>
      prev.map((row) =>
        row.name === invoice.patient
          ? { ...row, balance: row.balance + Math.round(original.amount * original.fxRate * 100) / 100 }
          : row
      )
    );
    setSelectedInvoice(updated);
    setReceipt(null);
    recordAudit({
      user: currentUser,
      action: 'Reversed payment',
      subject: invoice.id,
      detail: `${formatMoney(original.amount, original.currency)} · ${reason}`,
      severity: AUDIT.ALERT,
    });
    closeDialog();
    notify(`Payment reversed on ${invoice.id}`);
  };

  /**
   * An invoice's status, derived rather than stored.
   *
   * Three call sites used to compute this inline and disagreed: one never
   * produced "Part paid", another could never return to "Overdue" once a
   * payment was reversed, and none of them looked at the due date at all — so
   * an invoice forty days past due sat there labelled "Pending". Status is a
   * function of the balance and the calendar, so it is written once as one.
   */
  const settleStatus = (invoice) => {
    const outstanding = outstandingOn(invoice);
    if (outstanding <= 0) return { ...invoice, status: 'Paid', tone: 'success' };

    const overdue = (daysOverdue(invoice) ?? 0) > 0;
    const partly = outstanding < Number(invoice.patientResponsibility ?? 0);
    if (overdue) return { ...invoice, status: partly ? 'Part paid · overdue' : 'Overdue', tone: 'alert' };
    return { ...invoice, status: partly ? 'Part paid' : 'Pending', tone: partly ? 'accent' : 'warm' };
  };

  /**
   * Write off, or credit, part of a balance.
   *
   * The counterpart to a payment: the debt is discharged, but no money
   * arrived. Kept in its own ledger rather than booked as a payment of zero
   * cost, because a practice that cannot separate "collected" from "gave up
   * on" cannot see its bad debt — and the collections rate on the tiles above
   * would quietly climb every time someone wrote something off.
   *
   * Reception cannot reach this; see the note in the permission matrix.
   */
  const submitAdjustment = async (event) => {
    event.preventDefault();
    const invoice = invoiceData.find((i) => i.id === form.invoiceId) || selectedInvoice;
    const check = checkAdjustment(invoice, { amount: form.amount, reason: form.reason });
    if (!check.ok) {
      setFormErrors(check.message.startsWith('Give a fuller') ? { reason: check.message } : { amount: check.message });
      return;
    }
    setFormErrors({});

    if (live) {
      try {
        await api.billing.adjustBalance(invoice.apiId || invoice.id, {
          kind: form.adjustmentType || 'write_off',
          amount: check.amount,
          reason: form.reason.trim(),
        });
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        closeDialog();
        notify(`${formatMoney(check.amount, invoice.currency ?? billingCurrency)} adjusted on ${invoice.id}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const adjustment = {
      id: `ADJ-${String(Date.now()).slice(-8)}`,
      type: form.adjustmentType || 'write_off',
      amount: check.amount,
      currency: invoice.currency ?? billingCurrency,
      reason: form.reason.trim(),
      at: new Date().toISOString(),
      by: currentUser.name,
    };

    const updated = settleStatus({
      ...invoice,
      adjustments: [...(invoice.adjustments || []), adjustment],
    });

    setInvoiceData((prev) => prev.map((i) => (i.id === invoice.id ? updated : i)));
    setPatientRows((prev) =>
      prev.map((row) => (row.name === invoice.patient ? { ...row, balance: Math.max(0, row.balance - check.amount) } : row))
    );
    setSelectedInvoice(updated);
    recordAudit({
      user: currentUser,
      action: `Recorded ${adjustmentLabel(adjustment.type).toLowerCase()}`,
      subject: invoice.id,
      detail: `${formatMoney(adjustment.amount, adjustment.currency)} · ${adjustment.reason}`,
      severity: AUDIT.ALERT,
    });
    closeDialog();
    notify(`${formatMoney(adjustment.amount, adjustment.currency)} ${adjustmentLabel(adjustment.type).toLowerCase()} on ${invoice.id}`);
  };

  /**
   * Settle a patient's account with one tender.
   *
   * The patient at the desk hands over one amount and asks for it to go
   * against "what I owe", not against INV-2026-012 specifically. The tender is
   * applied oldest invoice first — the order every practice already uses on
   * paper, and the only one that does not leave the worst aging bucket
   * untouched while the practice books a payment from that same patient.
   */
  const submitStatementPayment = async (event) => {
    event.preventDefault();
    const statement = statementFor(form.patient, invoiceData, new Date());
    const tender = {
      amount: form.amount,
      currency: form.currency || statement.currency,
      fxRate: form.fxRate,
    };

    const check = checkStatementPayment(statement, tender);
    if (!check.ok) {
      setFormErrors({ amount: check.message });
      return;
    }
    setFormErrors({});

    if (live) {
      try {
        for (const allocation of check.allocations) {
          const invoice = invoiceData.find((item) => item.id === allocation.invoiceId);
          if (!invoice) continue;
          await api.billing.recordPayment(invoice.apiId || invoice.id, {
            amount: allocation.amount,
            currency: statement.currency,
            method: form.method || 'cash',
          });
        }
        await Promise.all([liveWorkspace.reload(), patientDirectory.reload()]);
        closeDialog();
        notify(`${formatMoney(check.applied, statement.currency)} applied to ${form.patient}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const receivedAt = new Date().toISOString();
    const byInvoice = new Map(check.allocations.map((a) => [a.invoiceId, a]));
    // Derived once, outside the update, so the receipt can name the rows it
    // created. An id invented inside the mapper is unreachable afterwards.
    const stamp = String(Date.now()).slice(-8);
    const paymentIdFor = (invoiceId) => `PAY-${stamp}-${invoiceId.slice(-3)}`;

    // One tender, one payment row per invoice it touched. Splitting it is what
    // makes each invoice's own ledger true; the receipt below is what ties the
    // rows back to the single amount the patient actually handed over.
    const touched = [];
    setInvoiceData((prev) =>
      prev.map((invoice) => {
        const allocation = byInvoice.get(invoice.id);
        if (!allocation) return invoice;
        const payment = {
          id: paymentIdFor(invoice.id),
          amount: allocation.amount,
          currency: statement.currency,
          fxRate: 1,
          method: form.method || 'cash',
          receivedAt,
          receivedBy: currentUser.name,
          reversesId: null,
          // Names the tender this row came out of, so a receptionist looking at
          // one invoice can see it was part of a larger settlement.
          allocatedFrom: `${formatMoney(Number(tender.amount), tender.currency)} across ${check.allocations.length} invoice${check.allocations.length === 1 ? '' : 's'}`,
        };
        const updated = settleStatus({ ...invoice, payments: [...(invoice.payments || []), payment] });
        touched.push(updated);
        return updated;
      })
    );

    setPatientRows((prev) =>
      prev.map((row) => (row.name === statement.patient ? { ...row, balance: Math.max(0, row.balance - check.applied) } : row))
    );

    const remaining = round2(statement.outstanding - check.applied);
    if (touched.length) setSelectedInvoice(touched[0]);
    fileReceipt({
      number: nextReceiptNumber(),
      invoiceReference: check.allocations.map((a) => a.invoiceId).join(', '),
      patient: statement.patient,
      tendered: { amount: Number(tender.amount), currency: tender.currency },
      appliedToInvoice: {
        amount: check.applied,
        currency: statement.currency,
        ...(check.rate !== 1 ? { rateUsed: check.rate } : {}),
      },
      method: form.method || 'cash',
      receivedAt,
      receivedBy: currentUser.name,
      balanceRemaining: remaining,
      status: remaining <= 0 ? 'Paid' : 'Part paid',
      allocations: check.allocations,
    }, check.allocations.map((a) => paymentIdFor(a.invoiceId)));

    recordAudit({
      user: currentUser,
      action: 'Settled account',
      subject: statement.patient,
      detail: `${formatMoney(Number(tender.amount), tender.currency)} across ${check.allocations.map((a) => a.invoiceId).join(', ')}`,
      severity: AUDIT.NOTICE,
    });
    setActiveView('billing');
    closeDialog();
    notify(`${formatMoney(Number(tender.amount), tender.currency)} settled across ${check.allocations.length} invoice${check.allocations.length === 1 ? '' : 's'} for ${statement.patient}`);
  };

  /**
   * Choose a service from the practice's own price list.
   *
   * The catalogue in Settings has carried a code, a description and a price per
   * service all along, and the invoice form asked reception to retype all three
   * for a service the practice had already configured. Selecting one fills the
   * line; every field stays editable afterwards, because the price list is what
   * the practice normally charges and an invoice is what it charged this time.
   */
  const selectService = (serviceId) => {
    const service = serviceById(catalogue, serviceId);
    const price = service ? priceOn(service) : null;
    setForm((prev) => ({
      ...prev,
      serviceId,
      ...(service
        ? {
          code: service.defaultTariffCode,
          service: service.billingDescription,
          amount: price ? String(price.amount) : prev.amount,
          standardAmount: price ? String(price.amount) : '',
          pricingMode: 'Standard price',
          priceReason: '',
          priceNote: '',
        }
        : {
          standardAmount: '',
          pricingMode: 'Custom price',
        }),
    }));
  };

  /**
   * Reprint the receipt for a payment already on the ledger.
   *
   * Prefers the receipt that was actually issued — same number, same wording,
   * same balance — because a reprint is a copy of a document, not a fresh
   * statement of where the account stands today.
   *
   * Where no stored receipt exists (a payment that predates the receipt log,
   * such as the seeded ones) it is rebuilt from the ledger and marked as such.
   * It deliberately does not invent a receipt number: a number that was never
   * on the original slip is worse than an honest "reissued from the ledger",
   * because the patient's copy and the practice's would disagree.
   */
  const reprintReceipt = (invoice, payment) => {
    const stored = receiptLog.find((entry) => entry.paymentIds?.includes(payment.id));
    if (stored) {
      setReceipt(stored);
    } else {
      setReceipt({
        ...buildReceipt(invoice, payment, balanceAfter(invoice, payment.id)),
        reissued: true,
      });
    }
    // Let the receipt render before the print dialog blocks the thread.
    window.setTimeout(printReceipt, 0);
  };

  /** Open the account view for whoever the desk is standing in front of. */
  const openStatement = (patient) =>
    openDialog('statement', { patient, currency: billingCurrency, method: 'cash' });

  /** The account as it stands right now, recomputed as payments land on it. */
  const statementInView = useMemo(
    () => (dialog === 'statement' && form.patient ? statementFor(form.patient, invoiceData, new Date()) : null),
    [dialog, form.patient, invoiceData],
  );

  const [seedMessageLog, setSeedMessageLog] = usePersistentState('messages', communicationLog);
  const messageLog = live ? liveWorkspace.messages : seedMessageLog;
  const setMessageLog = live ? liveWorkspace.setMessages : setSeedMessageLog;

  const submitMessage = async (event) => {
    event.preventDefault();
    const errors = {};
    if (!form.patient) errors.patient = 'Select a recipient';
    if (!form.message?.trim()) errors.message = 'Write a message';
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    if (live) {
      const patient = practicePatients.find((item) => item.name === form.patient);
      if (!patient?.patientId) {
        setFormErrors({ patient: 'Cannot resolve this live patient.' });
        return;
      }
      try {
        await api.messaging.send({
          patientId: patient.patientId,
          channel: String(form.channel || 'SMS').toLowerCase(),
          template: String(form.type || 'Manual message').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          body: form.message.trim(),
        });
        await liveWorkspace.reload();
        setActiveView('communications');
        closeDialog();
        notify(`Message queued to ${form.patient} via ${form.channel || 'SMS'}`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }

    const entry = {
      patient: form.patient,
      channel: form.channel || 'SMS',
      type: form.type?.trim() || 'Manual message',
      message: form.message.trim(),
      time: 'Just now',
      status: 'Queued',
      tone: 'warm',
    };
    setMessageLog((prev) => [entry, ...prev]);
    setActiveView('communications');
    closeDialog();
    notify(`Message queued to ${entry.patient} via ${entry.channel}`);
  };

  /** Builds a CSV in-browser and hands it to the user as a real download. */
  const exportCsv = (filename, columns, rows) => {
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [
      columns.map((c) => escape(c.label)).join(','),
      ...rows.map((row) => columns.map((c) => escape(c.get(row))).join(',')),
    ].join('\r\n');

    // Leading BOM so Excel opens the file as UTF-8 rather than mangling accents.
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    notify(`${filename} downloaded`);
  };

  const statusForApi = (status) => ({
    'Ready for provider': 'waiting_for_provider',
    'No-show': 'no_show',
  }[status] || String(status || '').toLowerCase().replace(/[\s-]+/g, '_'));

  const advanceVisitStatus = async (patient) => {
    if (live) {
      const appointment = todaysSchedule.find((item) => item.patient === patient);
      const currentIndex = visitStatusFlow.indexOf(visitStatuses[patient]);
      if (!appointment || currentIndex < 0 || currentIndex >= visitStatusFlow.length - 1) return;
      try {
        await api.appointments.setStatus(appointment.id, statusForApi(visitStatusFlow[currentIndex + 1]));
        await liveWorkspace.reload();
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    setVisitStatuses((prev) => {
      const currentIndex = visitStatusFlow.indexOf(prev[patient]);
      if (currentIndex < 0 || currentIndex >= visitStatusFlow.length - 1) return prev;
      return { ...prev, [patient]: visitStatusFlow[currentIndex + 1] };
    });
  };

  const markNoShow = async (patient) => {
    openDialog('visitStatus', {
      patient,
      status: 'no_show',
      label: 'Mark no show',
      reason: '',
    });
  };

  const cancelVisit = async (patient) => {
    openDialog('visitStatus', {
      patient,
      status: 'cancelled',
      label: 'Cancel visit',
      reason: '',
    });
  };

  const submitVisitStatusReason = async (event) => {
    event.preventDefault();
    const reason = (form.reason || '').trim();
    if (reason.length < 5) {
      setFormErrors({ reason: 'Record a short reason.' });
      return;
    }
    if (live) {
      const appointment = todaysSchedule.find((item) => item.patient === form.patient);
      if (!appointment) return;
      try {
        await api.appointments.setStatus(appointment.id, form.status, reason);
        await liveWorkspace.reload();
        closeDialog();
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    setVisitStatuses((prev) => ({
      ...prev,
      [form.patient]: form.status === 'cancelled' ? 'Cancelled' : 'No-show',
    }));
    closeDialog();
  };

  /**
   * Bill a visit that has already happened.
   *
   * By the time a visit is completed the system knows who was seen, by whom,
   * and what for — and reception was being asked to type all of it again into
   * an empty invoice form, from a screen they had to navigate away from to get
   * there. Everything here is already recorded against the appointment; this
   * only carries it across and leaves a human to confirm it.
   *
   * Deliberately prefill and not silent creation. An invoice is a demand for
   * money: raising one the moment a clinician marks a visit complete would bill
   * patients for consultations that were abandoned, duplicated, or recorded
   * against the wrong name, with nobody in the loop to catch it.
   */
  const billVisit = (appointment) => {
    if (!appointment) return;
    const service = serviceForVisitType(catalogue, appointment.type);
    const price = service ? priceOn(service) : null;
    openDialog('invoice', {
      patient: appointment.patient,
      fromVisit: appointment.id,
      ...(service
        ? {
          serviceId: service.id,
          code: service.defaultTariffCode,
          service: service.billingDescription,
          amount: price ? String(price.amount) : '',
          standardAmount: price ? String(price.amount) : '',
          pricingMode: 'Standard price',
          priceReason: '',
          priceNote: '',
        }
        : { service: appointment.type }),
    });
  };


  const [seedClaims, setSeedClaims] = usePersistentState('claims', initialClaims);
  const claims = live ? liveWorkspace.claims : seedClaims;
  const setClaims = live ? liveWorkspace.setClaims : setSeedClaims;
  const [selectedClaimId, setSelectedClaimId] = useState(null);

  // Frontend-only simulation of the claims gateway round-trip; live mode uses
  // the canonical claim engine and whichever adapter the claim is configured for.
  const updateClaim = (id, updater) => {
    setClaims((prev) => prev.map((claim) => (claim.id === id ? updater(claim) : claim)));
  };

  const captureBiometric = async (id) => {
    if (live) {
      const claim = claims.find((item) => item.id === id);
      try {
        await api.claims.captureBiometric(claim?.apiId || id);
        await liveWorkspace.reload();
        notify(`${id} biometric captured`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Biometric verified',
      biometric: 'Fingerprint matched · just now',
      responses: [...claim.responses, { label: 'Member verified at terminal BIO-02', time: 'Just now', tone: 'success' }],
    }));
  };

  const prepareEmailClaimForm = (id) => {
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Form prepared',
      submissionChannel: 'Email',
      emailSubmission: {
        providerEmail: claim.emailSubmission?.providerEmail || 'claims@international-provider.example',
        claimForm: claim.emailSubmission?.claimForm || `${claim.plan || claim.payerName || 'International insurer'} claim form`,
        preparedBy: claim.emailSubmission?.preparedBy || currentUser.name,
        reviewLink: claim.emailSubmission?.reviewLink || 'Secure client review link generated',
        authenticationMethod: claim.emailSubmission?.authenticationMethod || 'OTP + declaration',
        authentication: claim.emailSubmission?.authentication || 'Not authenticated',
        requiredDocuments: claim.emailSubmission?.requiredDocuments || ['Claim form', 'Itemised invoice', 'Clinical notes'],
        attachments: claim.emailSubmission?.attachments || ['Claim form draft', `${claim.invoice || claim.id} itemised invoice`],
        subject: claim.emailSubmission?.subject || `Claim ${claim.id} · ${claim.patient} · ${claim.memberNo || 'member pending'}`,
        followUp: claim.emailSubmission?.followUp || '3 business days after submission',
      },
      responses: [
        ...(claim.responses || []),
        { label: 'Email claim form prepared for client review', time: 'Just now', tone: 'success' },
      ],
    }));
    notify(`${id} email claim form prepared`);
  };

  const sendClaimForClientAuthentication = (id) => {
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Awaiting client authentication',
      submissionChannel: 'Email',
      emailSubmission: {
        ...(claim.emailSubmission || {}),
        reviewLink: claim.emailSubmission?.reviewLink || 'Secure client review link generated',
        authenticationMethod: claim.emailSubmission?.authenticationMethod || 'OTP + declaration',
        authentication: 'Sent to client',
      },
      responses: [
        ...(claim.responses || []),
        { label: 'Secure review link sent to client for OTP declaration', time: 'Just now', tone: 'warm' },
      ],
    }));
    notify(`${id} sent to client for authentication`);
  };

  const authenticateEmailClaim = (id) => {
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Client authenticated',
      submissionChannel: 'Email',
      emailSubmission: {
        ...(claim.emailSubmission || {}),
        authentication: `OTP declaration accepted by ${claim.patient}`,
        authenticatedAt: 'Just now',
      },
      responses: [
        ...(claim.responses || []),
        { label: `Client authenticated claim pack by OTP declaration`, time: 'Just now', tone: 'success' },
      ],
    }));
    notify(`${id} authenticated by client`);
  };

  // Identity now comes from the session, not a switcher. Role still drives the
  // permission matrix; identity drives which patients those permissions reach.
  const currentRole = currentUser.role;
  const access = roleAccess[currentRole];
  const roleInfo = {
    id: currentRole,
    // Job title is what a person calls themselves and is the better label, but
    // it is optional on the server — so the role carries it when it is absent.
    // Without the fallback this renders as an empty line under the name in the
    // account menu, and as "The  role covers..." in the restricted views.
    label: currentUser.jobTitle || ROLE_LABELS[currentRole] || currentRole,
    person: currentUser.name,
    initials: currentUser.initials,
  };
  const doctorIdentity = currentUser.name;

  /* ---------------------------------------------------------------------
   * Access scoping
   *
   * Layer 1 (tenant) is absolute: `practicePatients` is the widest set anyone
   * in this session can ever reach. Layer 3 (relationship) narrows that to the
   * clinician's own list, with break-glass as the documented way through.
   * ------------------------------------------------------------------- */
  const [grants, setGrants] = usePersistentState('grants', initialGrants);
  const [allSettings, setAllSettings] = usePersistentState('settings', defaultSettings);
  const [directory, setDirectory] = usePersistentState('users', seedUsers);

  const practiceSettings = live
    ? settingsFromApi(liveWorkspace.settings || {}, liveSettingsShell(practice))
    : (
      allSettings[currentUser.practiceId] ||
      defaultSettings[currentUser.practiceId] ||
      Object.values(defaultSettings).find(
        (candidate) =>
          candidate.profile.name === practice.name ||
          candidate.profile.short === practice.short
      ) ||
      Object.values(defaultSettings)[0]
    );
  const settings = {
    ...practiceSettings,
    profile: {
      ...practiceSettings.profile,
      name: practice.name || practiceSettings.profile.name,
      short: practice.short || practiceSettings.profile.short,
      city: practice.location || practiceSettings.profile.city,
    },
  };

  /**
   * The practice's billing currency, and the formatters bound to it.
   *
   * `primaryCurrency` has been editable in Settings since the settings screen
   * existed, and nothing in the money path read it — every figure in the
   * workspace printed a hardcoded ZWL regardless of what the practice was
   * configured to bill in. These are the single point where that setting
   * reaches the UI, so changing it in Settings now changes the workspace.
   */
  const billingCurrency = settings.profile.primaryCurrency || FALLBACK_CURRENCY;
  const currency = useMemo(() => currencyFor(billingCurrency), [billingCurrency]);
  const money = useCallback(
    (amount, code) => formatMoney(amount, code ?? billingCurrency),
    [billingCurrency]
  );

  const updateSettings = (next) => {
    setAllSettings((prev) => ({ ...prev, [currentUser.practiceId]: next }));
    recordAudit({ user: currentUser, action: 'Configuration changed', subject: practice.short, severity: AUDIT.NOTICE });
  };
  const practiceUsers = live
    ? [{
        id: currentUser.id,
        practiceId: currentUser.practiceId,
        role: currentUser.role,
        name: currentUser.name,
        fullName: currentUser.fullName || currentUser.name,
        initials: currentUser.initials,
        jobTitle: currentUser.jobTitle,
        email: currentUser.email,
        active: true,
      }]
    : directory.filter((u) => u.practiceId === currentUser.practiceId);
  const updateUser = (userId, changes) =>
    setDirectory((prev) => prev.map((u) => (u.id === userId ? { ...u, ...changes } : u)));

  // Configuration now drives the app rather than sitting in a settings screen:
  // deactivate a room here and it disappears from the calendar.
  const configuredProviderRecords = (settings?.providers || []).filter((provider) => provider.active !== false);
  const configuredProviders = configuredProviderRecords.map((provider) => provider.name);
  const providerIdForName = (name) =>
    configuredProviderRecords.find((provider) => provider.name === name)?.id || null;
  const configuredRooms = activeRoomNames(settings);
  const defaultProviderName = configuredProviders[0] || 'Unassigned';
  const defaultRoomName = configuredRooms[0] || 'Unassigned';

  /**
   * The service catalogue and the tariff schedules behind it.
   *
   * Both are practice-owned data rather than constants: a price list and a
   * payer schedule are exactly the things a practice has to change without a
   * deployment. Held per practice and scoped on read, like every other
   * collection here.
   */
  const [catalogueData, setCatalogueData] = usePersistentState('catalogue', initialCatalogue);
  const [tariffData, setTariffData] = usePersistentState('tariffs', initialTariffs);
  const [batchData, setBatchData] = usePersistentState('importBatches', []);
  const [profileData, setProfileData] = usePersistentState('mappingProfiles', []);
  const [payerData] = usePersistentState('payers', initialPayers);

  const catalogue = useMemo(
    () => catalogueData[currentUser.practiceId] ?? [],
    [catalogueData, currentUser.practiceId]
  );
  const configuredServices = useMemo(() => catalogueServices(catalogue), [catalogue]);

  /**
   * The tariff seam.
   *
   * Everything that needs to know what a scheme will pay goes through this,
   * and nothing upstream knows the answer came from a local schedule. When a
   * real payer integration lands it replaces this object and nothing else.
   */
  const tariffProvider = useMemo(
    () => createTariffProvider({ tariffs: tariffData, practiceId: currentUser.practiceId }),
    [tariffData, currentUser.practiceId]
  );

  /**
   * The scheme a patient is actually covered by.
   *
   * Cover is captured once, at registration, and lives on the patient *record*
   * — while billing looks patients up in the *registry*, which carries a
   * membership number but no plan. `schemeRate` was therefore always handed
   * `undefined` and always fell through to `schemes[0]`, so every invoice in
   * the system was priced at Plan A's 90% no matter what the patient was
   * actually on. A Plan B patient was under-billed by ten points of every
   * service line, silently, on every invoice.
   *
   * Reads the record first and falls back to self-pay rather than to the most
   * generous scheme: guessing high bills the patient too little and the scheme
   * too much, which is the direction that gets a claim rejected.
   */
  const coverPlanFor = (patient) => {
    if (!patient) return 'Self-pay';
    return patientRecords[patient.id]?.coverPlan
      || (patient.memberNo ? settings.schemes[0]?.name : 'Self-pay')
      || 'Self-pay';
  };

  /* ---------------------------------------------------------------- *
   * Orders and the billing engine.
   * ---------------------------------------------------------------- */

  const [orderData, setOrderData] = usePersistentState('orders', initialOrders);
  const updateOrder = (id, patch) =>
    setOrderData((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));

  /**
   * Turn a billable order into an invoice line.
   *
   * Appends to the patient's open invoice for the day where one exists, so a
   * visit with three orders produces one invoice rather than three. The
   * idempotency key is written onto the line, which is what makes a repeated
   * completion event a no-op rather than a second charge.
   */
  const runBillingEngine = (order) => {
    const service = serviceForOrder(order);
    const decision = billingDecision(order, service, { alreadyBilled: billedKeysFrom(practiceInvoices) });
    if (!decision.bill) {
      notify(`${order.serviceName} completed, ${decision.reason.toLowerCase()}`);
      return;
    }

    const patient = practicePatients.find((p) => p.id === order.patientId);
    const priced = priceServiceFor(service, patient, { quantity: order.quantity });
    if (!priced) return;

    const line = {
      ...priced,
      amount: priced.gross,
      insurance: priced.estimatedFunder,
      billingKey: decision.key,
      orderId: order.id,
    };

    const today = new Date().toISOString().slice(0, 10);
    const open = practiceInvoices.find(
      (inv) => inv.patient === order.patientName && inv.issuedOn === today && inv.status !== 'Paid'
    );

    if (open) {
      const services = [...open.services, line];
      const updated = settleStatus({
        ...open,
        services,
        amount: round2(open.amount + line.gross),
        patientResponsibility: round2(open.patientResponsibility + priced.estimatedPatient),
      });
      setInvoiceData((prev) => prev.map((i) => (i.id === open.id ? updated : i)));
      setPatientRows((prev) => prev.map((p) => (p.name === order.patientName ? { ...p, balance: p.balance + line.gross } : p)));
      updateOrder(order.id, { billedKey: decision.key, invoiceId: open.id });
      attachToOpenEpisode(patient, { linkedOrderIds: order.id, linkedInvoiceIds: open.id });
      setSelectedInvoice(updated);
      recordAudit({
        user: currentUser,
        action: 'Billed a completed order',
        subject: open.id,
        detail: `${service.displayName}, ${formatMoney(line.gross, billingCurrency)}, ${order.id}`,
        severity: AUDIT.NOTICE,
      });
      notify(`${service.displayName} added to ${open.id}, patient ${formatMoney(priced.estimatedPatient, billingCurrency)}`);
      return;
    }

    const due = new Date();
    due.setDate(due.getDate() + 30);
    const invoice = settleStatus({
      id: `INV-2026-${String(15 + invoiceData.length - initialInvoices.length).padStart(3, '0')}`,
      patient: order.patientName,
      date: 'Today',
      issuedOn: today,
      dueDate: due.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      dueOn: due.toISOString().slice(0, 10),
      amount: line.gross,
      currency: billingCurrency,
      claim: 'Not submitted',
      claimStatus: 'Draft',
      services: [line],
      patientResponsibility: priced.estimatedPatient,
      insurance: coverPlanFor(patient),
      payments: [],
      adjustments: [],
    });

    setInvoiceData((prev) => [invoice, ...prev]);
    setPatientRows((prev) => prev.map((p) => (p.name === order.patientName ? { ...p, balance: p.balance + line.gross } : p)));
    updateOrder(order.id, { billedKey: decision.key, invoiceId: invoice.id });
    attachToOpenEpisode(patient, { linkedOrderIds: order.id, linkedInvoiceIds: invoice.id });
    setSelectedInvoice(invoice);
    recordAudit({
      user: currentUser,
      action: 'Billed a completed order',
      subject: invoice.id,
      detail: `${service.displayName}, ${formatMoney(line.gross, billingCurrency)}, ${order.id}`,
      severity: AUDIT.NOTICE,
    });
    notify(`${service.displayName} billed, ${invoice.id}, patient ${formatMoney(priced.estimatedPatient, billingCurrency)}`);
  };

  const submitPrescription = async (event) => {
    event.preventDefault();
    const patient = form.patient;
    const record = patient ? patientRecords[patient.id] : null;
    const errors = {};
    if (!form.drug?.trim()) errors.drug = 'Medication name is required';
    if (!form.strength?.trim()) errors.strength = 'Strength is required';
    if (!form.route?.trim()) errors.route = 'Route is required';
    if (!form.frequency?.trim()) errors.frequency = 'Frequency or directions are required';
    if (!form.durationDays) errors.durationDays = 'Duration is required';
    if (!record?.allergiesRecorded && !form.allergiesReviewed) {
      errors.allergiesReviewed = 'Confirm allergy review before issuing';
    }
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    try {
      const rx = await createPrescription({
        patient,
        drug: form.drug,
        form: form.form,
        strength: form.strength,
        dose: form.dose,
        route: form.route,
        frequency: form.frequency,
        durationDays: form.durationDays,
        quantity: form.quantity,
        refills: form.refills ?? 0,
        indication: form.indication,
        pharmacy: form.pharmacy,
        substitutionAllowed: form.substitutionAllowed === '' || form.substitutionAllowed === undefined
          ? undefined : form.substitutionAllowed === 'true',
        instructions: form.instructions,
        allergiesReviewed: record?.allergiesRecorded || Boolean(form.allergiesReviewed),
      });
      closeDialog();
      notify(`Prescription issued for ${patient.name} — ${rx.drug} ${rx.strength || ''}`.trim());
    } catch (error) {
      setFormErrors({
        submit: error.code === 'conflict' && error.details?.code === 'ALLERGY_REVIEW_REQUIRED'
          ? 'Review this patient’s allergies and confirm the checkbox before issuing.'
          : error.message,
      });
    }
  };

  /**
   * Turn a typed/pasted dictation transcript into a structured draft.
   *
   * Dictation is an encounter-scoped resource server-side, so this reuses
   * today's open (unsigned) note for the patient if one exists, and quietly
   * opens a lightweight draft encounter otherwise — the doctor never has to
   * leave the Prescribe tab to get there.
   */
  const structureDictation = async (event) => {
    event.preventDefault();
    const patient = form.patient;
    const transcript = (form.transcript || '').trim();
    if (transcript.length < 12) {
      setFormErrors({ transcript: 'Dictate or paste at least a sentence describing the prescription' });
      return;
    }
    setFormErrors({});
    setForm((prev) => ({ ...prev, structuring: true }));
    try {
      let encounterId = encounters.find((e) => e.patientId === patient.id && e.status === 'Draft')?.id;
      if (!encounterId) {
        const created = await api.encounters.createDraft({ patientId: patient.patientId ?? patient.id });
        encounterId = created.id;
        setLiveEncounters((prev) => [encounterFromApi(created, patient), ...prev]);
      }
      const dictation = await api.encounters.createDictation(encounterId, { transcript });
      const structured = await api.dictations.structure(dictation.id);
      const draft = structured.structured_draft || {};
      const medicationsMentioned = Array.isArray(draft.medicationsMentioned) ? draft.medicationsMentioned : [];
      setForm((prev) => ({
        ...prev,
        structuring: false,
        dictationId: dictation.id,
        medicationsMentioned,
        selectedMedicationIndex: medicationsMentioned.length ? 0 : null,
        ...(medicationsMentioned[0] ? {
          drug: medicationsMentioned[0].drug || '',
          strength: medicationsMentioned[0].strength || '',
          route: medicationsMentioned[0].route || '',
          frequency: medicationsMentioned[0].frequency || '',
          durationDays: medicationsMentioned[0].durationDays || '',
        } : {}),
      }));
      if (medicationsMentioned.length === 0) {
        notify('No medication was recognised in that dictation — check the fields below before approving');
      }
    } catch (error) {
      setForm((prev) => ({ ...prev, structuring: false }));
      setFormErrors({ submit: error.message });
    }
  };

  const selectDictatedMedication = (index) => {
    const med = form.medicationsMentioned?.[index];
    if (!med) return;
    setForm((prev) => ({
      ...prev,
      selectedMedicationIndex: index,
      drug: med.drug || '',
      strength: med.strength || '',
      route: med.route || '',
      frequency: med.frequency || '',
      durationDays: med.durationDays || '',
    }));
  };

  const approveDictatedPrescription = async (event) => {
    event.preventDefault();
    const patient = form.patient;
    const record = patient ? patientRecords[patient.id] : null;
    const errors = {};
    if (!form.drug?.trim()) errors.drug = 'Medication name is required';
    if (!record?.allergiesRecorded && !form.allergiesReviewed) {
      errors.allergiesReviewed = 'Confirm allergy review before issuing';
    }
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    try {
      const result = await api.dictations.approvePrescription(form.dictationId, {
        drug: form.drug,
        strength: form.strength || undefined,
        route: form.route || undefined,
        frequency: form.frequency || undefined,
        durationDays: form.durationDays ? Number(form.durationDays) : undefined,
        allergiesReviewed: record?.allergiesRecorded || Boolean(form.allergiesReviewed),
      });
      const mapped = prescriptionFromApi(result.prescription, roleInfo.person ?? currentUser.name);
      setPatientRecords((prev) => ({
        ...prev,
        [patient.id]: {
          ...prev[patient.id],
          prescriptions: [mapped, ...(prev[patient.id]?.prescriptions ?? [])],
        },
      }));
      closeDialog();
      notify(`Prescription issued for ${patient.name} — ${mapped.drug} ${mapped.strength || ''}`.trim());
    } catch (error) {
      setFormErrors({
        submit: error.code === 'conflict' && error.details?.code === 'ALLERGY_REVIEW_REQUIRED'
          ? 'Review this patient’s allergies and confirm the checkbox before issuing.'
          : error.message,
      });
    }
  };

  const placeOrder = (event) => {
    event.preventDefault();
    const errors = {};
    if (!form.patient) errors.patient = 'Select a patient';
    if (!form.serviceId) errors.serviceId = 'Choose a service';
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const patient = practicePatients.find((p) => p.name === form.patient);
    const service = serviceById(catalogue, form.serviceId);
    const order = {
      id: `ORD-${new Date().getFullYear()}-${String(orderData.length + 50).padStart(4, '0')}`,
      practiceId: currentUser.practiceId,
      patientId: patient.id,
      patientName: patient.name,
      serviceId: service.id,
      serviceName: service.displayName,
      department: service.department,
      quantity: Number(form.quantity) || service.defaultQuantity || 1,
      priority: form.priority || 'Routine',
      orderedBy: roleInfo.person ?? currentUser.name,
      orderedAt: new Date().toISOString(),
      status: ORDER_STATUS.ORDERED,
      completedAt: null,
      completedBy: null,
      clinicalNotes: form.clinicalNotes?.trim() ?? '',
      cancellationReason: null,
      invoiceId: null,
      billedKey: null,
    };

    setOrderData((prev) => [order, ...prev]);
    attachToOpenEpisode(patient, { linkedOrderIds: order.id });
    recordAudit({
      user: currentUser,
      action: 'Ordered a service',
      subject: patient.name,
      detail: `${service.displayName}, ${order.priority}`,
      severity: AUDIT.INFO,
    });
    closeDialog();
    notify(`${service.displayName} ordered for ${patient.name}`);
  };

  /**
   * Move an order along, and bill it if that is what the move means.
   *
   * Billing is a consequence of the clinical event, never a separate step
   * someone has to remember. The engine is asked after every transition and
   * decides for itself whether the service's trigger has been reached.
   */
  const advanceOrder = (order) => {
    const next = nextOrderStatus(order.status);
    if (!next) return;
    const moved = {
      ...order,
      status: next,
      ...(next === ORDER_STATUS.COMPLETED
        ? { completedAt: new Date().toISOString(), completedBy: roleInfo.person ?? currentUser.name }
        : {}),
    };
    updateOrder(order.id, moved);
    if (next === ORDER_STATUS.COMPLETED) runBillingEngine(moved);
    else notify(`${order.serviceName}, ${next.toLowerCase()}`);
  };

  const cancelOrder = (event) => {
    event.preventDefault();
    const reason = (form.reason || '').trim();
    if (reason.length < 5) {
      setFormErrors({ reason: 'Say why this was cancelled.' });
      return;
    }
    setFormErrors({});
    updateOrder(form.orderId, {
      status: form.decline ? ORDER_STATUS.DECLINED : ORDER_STATUS.CANCELLED,
      cancellationReason: reason,
    });
    recordAudit({
      user: currentUser,
      action: form.decline ? 'Declined an order' : 'Cancelled an order',
      subject: form.orderId,
      detail: reason,
      severity: AUDIT.NOTICE,
    });
    closeDialog();
    notify(`${form.serviceName} ${form.decline ? 'declined' : 'cancelled'}, nothing billed`);
  };

  const importBatches = useMemo(
    () => batchData.filter((b) => b.practiceId === currentUser.practiceId),
    [batchData, currentUser.practiceId]
  );

  const mappingProfiles = useMemo(
    () => profileData.filter((p) => p.practiceId === currentUser.practiceId),
    [profileData, currentUser.practiceId]
  );

  /**
   * Remember how a payer's columns map.
   *
   * Configured once and applied to that payer's next upload, which is the
   * difference between mapping nine columns every month and confirming them.
   * Replaces any earlier profile for the same layout rather than stacking, so
   * the list stays something a person can read.
   */
  const saveMappingProfile = (profile) => {
    const stored = { ...profile, practiceId: currentUser.practiceId };
    setProfileData((prev) => [
      stored,
      ...prev.filter((p) => !(p.practiceId === stored.practiceId
        && p.kind === stored.kind
        && p.payerId === stored.payerId
        && p.headerSignature === stored.headerSignature)),
    ]);
    recordAudit({
      user: currentUser,
      action: 'Saved a column mapping',
      subject: profile.name,
      detail: Object.entries(profile.mapping).filter(([, h]) => h).map(([f, h]) => `${h} to ${f}`).join(', '),
      severity: AUDIT.INFO,
    });
    notify(`Mapping saved as "${profile.name}"`);
  };

  /**
   * Teach the catalogue a description it did not recognise.
   *
   * The decision a reviewer just made, kept — so the same schedule stops
   * needing the same manual match every month. Attributable on purpose: an
   * alias silently changes what a later import resolves to.
   */
  const addServiceAlias = async (serviceId, alias, payerId) => {
    const text = String(alias ?? '').trim();
    const service = serviceById(catalogue, serviceId);
    if (!service || !text) return;
    if (service.aliases?.some((a) => a.toLowerCase() === text.toLowerCase())) {
      notify(`"${text}" is already an alias for ${service.displayName}`);
      return;
    }

    if (live) {
      try {
        await api.catalogue.addAlias(serviceId, { alias: text, payerId });
      } catch (error) {
        notify(error.message);
        return;
      }
    }

    const record = makeAlias({ serviceId, alias: text, source: 'import', payerId, approvedBy: currentUser.name });
    setCatalogueData((prev) => ({
      ...prev,
      [currentUser.practiceId]: (prev[currentUser.practiceId] ?? []).map((entry) =>
        entry.id === serviceId
          ? { ...entry, aliases: [...(entry.aliases ?? []), record.alias] }
          : entry),
    }));
    recordAudit({
      user: currentUser,
      action: 'Confirmed a service alias',
      subject: service.displayName,
      detail: `"${record.alias}" will match ${service.displayName} in future imports`,
      severity: AUDIT.NOTICE,
    });
    notify(`"${record.alias}" now matches ${service.displayName}`);
  };

  /**
   * Publish a reviewed service catalogue batch.
   *
   * An update re-prices the existing service through the same effective-dated
   * mechanism the settings screen uses, so a price list upload cannot rewrite
   * what an invoice was charged under last month either.
   */
  const publishServiceBatch = async ({ batch, records, mapping = {}, counts = {}, filename }) => {
    if (live) {
      try {
        await api.catalogue.publishServices({
          filename: filename || batch.filename,
          mapping,
          counts,
          rows: records,
        });
      } catch (error) {
        notify(error.message);
        return false;
      }
    }

    setCatalogueData((prev) => {
      const mine = prev[currentUser.practiceId] ?? [];
      const updated = mine.map((service) => {
        const incoming = records.find((r) => r.isUpdate && r.id === service.id);
        if (!incoming) return service;
        const period = incoming.price[0];
        return {
          ...repriceService(service, {
            amount: period.amount, currency: period.currency, effectiveFrom: period.effectiveFrom,
          }),
          billingDescription: incoming.billingDescription,
          department: incoming.department,
          category: incoming.category,
          billingTrigger: incoming.billingTrigger,
          defaultTariffCode: incoming.defaultTariffCode || service.defaultTariffCode,
          active: incoming.active,
        };
      });
      // `isUpdate` is a staging flag, not part of a service. Stripped rather
      // than stored, so nothing downstream can start depending on it.
      const created = records.filter((r) => !r.isUpdate).map((record) => {
        const service = { ...record };
        delete service.isUpdate;
        return service;
      });
      return { ...prev, [currentUser.practiceId]: [...updated, ...created] };
    });

    setBatchData((prev) => [{ ...batch, practiceId: currentUser.practiceId }, ...prev]);
    recordAudit({
      user: currentUser,
      action: 'Published a service price list',
      subject: batch.filename,
      detail: `${records.length} services, batch ${batch.id}`,
      severity: AUDIT.ALERT,
    });
    notify(`${records.length} services published from ${batch.filename}`);
    return true;
  };

  /**
   * Publish a reviewed tariff batch.
   *
   * Supersedes rather than overwrites: the rate a new one replaces has its
   * period closed the day before the new one opens and stays in the table, so
   * an invoice raised under it can still explain itself. That is also what
   * makes the rollback beside it safe — nothing was destroyed to undo.
   */
  const publishTariffBatch = async ({ batch, records, mapping = {}, counts = {}, filename }) => {
    if (live) {
      try {
        await api.catalogue.publishTariffs({
          filename: filename || batch.filename,
          payerId: batch.payerId,
          mapping,
          counts,
          rows: records,
        });
      } catch (error) {
        notify(error.message);
        return false;
      }
    }

    setTariffData((prev) => publishTariffs(prev, records));
    setBatchData((prev) => [{ ...batch, practiceId: currentUser.practiceId }, ...prev]);
    recordAudit({
      user: currentUser,
      action: 'Published a tariff schedule',
      subject: batch.filename,
      detail: `${batch.payerName}, ${records.length} rates, batch ${batch.id}`,
      severity: AUDIT.ALERT,
    });
    notify(`${records.length} tariffs published from ${batch.filename}`);
    return true;
  };

  /**
   * Undo a batch without touching the books.
   *
   * The batch's own rows are deactivated and the periods they closed reopen.
   * Invoices already raised at those rates are deliberately left alone: an
   * invoice states what was charged at the time, and re-pricing history to
   * match a corrected schedule would be falsifying the record rather than
   * fixing it.
   */
  const rollbackTariffBatch = (batch) => {
    setTariffData((prev) => rollbackBatch(prev, batch.id));
    setBatchData((prev) => prev.map((b) => (b.id === batch.id ? { ...b, status: 'ROLLED_BACK' } : b)));
    recordAudit({
      user: currentUser,
      action: 'Rolled back a tariff schedule',
      subject: batch.filename,
      detail: `batch ${batch.id}, prior rates reinstated, invoices unchanged`,
      severity: AUDIT.ALERT,
    });
    notify(`${batch.filename} rolled back, previous rates are in force again`);
  };

  /**
   * Re-price a service from a date.
   *
   * Goes through `repriceService` rather than editing the number in place, so
   * the previous price is closed off and kept. The old settings screen edited
   * `price` directly, which meant changing a fee silently re-priced every
   * invoice that had ever been raised under it.
   */
  const repriceCatalogueService = (serviceId, { amount, effectiveFrom }) => {
    const service = serviceById(catalogue, serviceId);
    if (!service) return;
    const previous = priceOn(service, effectiveFrom);

    setCatalogueData((prev) => ({
      ...prev,
      [currentUser.practiceId]: (prev[currentUser.practiceId] ?? []).map((entry) =>
        entry.id === serviceId
          ? repriceService(entry, { amount: Number(amount), currency: billingCurrency, effectiveFrom })
          : entry),
    }));

    recordAudit({
      user: currentUser,
      action: 'Re-priced a service',
      subject: service.displayName,
      detail: `${previous ? formatMoney(previous.amount, previous.currency) : 'unpriced'} → ${formatMoney(Number(amount), billingCurrency)} from ${effectiveFrom}`,
      severity: AUDIT.NOTICE,
    });
    closeDialog();
    notify(`${service.displayName} priced at ${formatMoney(Number(amount), billingCurrency)} from ${effectiveFrom}`);
  };

  /** The payer and plan a patient is covered by, or null for self-pay. */
  const coverFor = (patient) =>
    planByName(payerData, currentUser.practiceId, coverPlanFor(patient)) ?? {};

  /**
   * Price a service for a patient on a date.
   *
   * The one entry point from the workspace into the pricing layer: practice
   * price, tariff resolution, and the estimated split all resolve behind it.
   * Nothing in the UI computes a percentage of anything.
   */
  const priceServiceFor = (service, patient, { quantity = 1, on = new Date() } = {}) =>
    priceLine({ service, quantity, ...coverFor(patient), provider: tariffProvider, on });
  const [breakGlassFor, setBreakGlassFor] = useState(null);
  const [breakGlassReason, setBreakGlassReason] = useState('');
  const [showWholePractice, setShowWholePractice] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(null); // null | 'alerts' | 'user' | 'workspace'
  const closeHeaderMenu = () => setHeaderMenu(null);
  const toggleHeaderMenu = (name) => setHeaderMenu((open) => (open === name ? null : name));
  const demoPracticeOptions = useMemo(() => seededPractices.map((option) => ({
    ...option,
    switchUser:
      seedUsers.find((user) => user.practiceId === option.id && user.role === currentUser.role) ||
      seedUsers.find((user) => user.practiceId === option.id && user.role === 'manager') ||
      seedUsers.find((user) => user.practiceId === option.id),
  })), [currentUser.role]);
  const [resetOpen, setResetOpen] = useState(false);

  const practicePatients = useMemo(
    () => patientsInPractice(currentUser, patientRows),
    [currentUser, patientRows]
  );

  const accessContext = useMemo(
    () => ({ appointments: mockSchedule, notes: encounters, grants }),
    [mockSchedule, encounters, grants]
  );

  const myPatientList = useMemo(
    () => patientsInCare(currentUser, patientRows, access, accessContext),
    [currentUser, patientRows, access, accessContext]
  );

  /* ---------------------------------------------------------------------
   * Tenant scoping for every other collection.
   *
   * Appointments, invoices, claims, notes, and messages all reference a
   * patient. Rather than tagging each row with a practice — which can drift —
   * they inherit tenancy from the patient they belong to: if the patient is
   * not in your practice, neither is their appointment or invoice.
   *
   * Mutations still write to the unscoped state; only what is *read* and
   * rendered passes through here.
   * ------------------------------------------------------------------- */
  const practicePatientNames = useMemo(
    () => new Set(practicePatients.map((p) => p.name)),
    [practicePatients]
  );

  const practiceSchedule = useMemo(
    () => mockSchedule.filter((a) => practicePatientNames.has(a.patient)),
    [mockSchedule, practicePatientNames]
  );
  const todaysSchedule = useMemo(
    () => practiceSchedule.filter((a) => (a.day ?? 0) === 0),
    [practiceSchedule]
  );
  const practiceInvoices = useMemo(
    () => invoiceData.filter((i) => practicePatientNames.has(i.patient)),
    [invoiceData, practicePatientNames]
  );

  const practiceOrders = useMemo(
    () => orderData.filter((o) => o.practiceId === currentUser.practiceId),
    [orderData, currentUser.practiceId]
  );

  const serviceForOrder = useCallback(
    (order) => serviceById(catalogue, order.serviceId),
    [catalogue]
  );

  /**
   * Orders that have reached their trigger and have not been charged.
   *
   * Derived from state rather than driven by an event queue. A queue can be
   * missed, replayed out of order, or lost when the tab closes; a derivation
   * cannot drift from what it derives from, and the idempotency key still
   * guarantees one charge per event however often this recomputes.
   */
  const billableOrders = useMemo(
    () => ordersAwaitingBilling(practiceOrders, serviceForOrder, billedKeysFrom(practiceInvoices)),
    [practiceOrders, serviceForOrder, practiceInvoices]
  );


  /**
   * Visits that have been seen but not yet billed.
   *
   * Matched on the appointment id recorded against the invoice rather than on
   * patient-and-date: a patient seen twice in one day is two visits and two
   * invoices, and anything coarser would silently treat the second as already
   * billed.
   */
  const unbilledVisits = useMemo(
    () => todaysSchedule.filter(
      (appointment) => visitStatuses[appointment.patient] === 'Completed'
        && !invoiceData.some((invoice) => invoice.fromVisit === appointment.id)
    ),
    [todaysSchedule, visitStatuses, invoiceData]
  );
  const practiceClaims = useMemo(
    () => claims.filter((c) => practicePatientNames.has(c.patient)),
    [claims, practicePatientNames]
  );

  /**
   * The current selection on each detail page.
   *
   * Resolved against the tenant-scoped list rather than the raw seed, so a
   * selection can never name a record from another practice — including the
   * first one, which is the case that was actually wrong. Falls back to the
   * first record the user may see, and to `null` when they have none: a
   * practice with no invoices yet is an ordinary state, not an error, and the
   * pages render an empty state for it.
   */
  const selectedAppointment = useMemo(
    () => practiceSchedule.find((a) => a.id === selectedAppointmentId) ?? practiceSchedule[0] ?? null,
    [practiceSchedule, selectedAppointmentId]
  );
  const selectedInvoice = useMemo(
    () => practiceInvoices.find((i) => i.id === selectedInvoiceId) ?? practiceInvoices[0] ?? null,
    [practiceInvoices, selectedInvoiceId]
  );
  const selectedClaim = useMemo(
    () => practiceClaims.find((c) => c.id === selectedClaimId) ?? practiceClaims[0] ?? null,
    [practiceClaims, selectedClaimId]
  );

  const setSelectedAppointment = (appointment) => setSelectedAppointmentId(appointment?.id ?? null);
  const setSelectedInvoice = (invoice) => setSelectedInvoiceId(invoice?.id ?? null);

  useEffect(() => {
    if (!live || !selectedInvoice?.apiId) return undefined;
    let cancelled = false;
    api.billing
      .getInvoice(selectedInvoice.apiId)
      .then((row) => {
        if (cancelled) return;
        const detailed = invoiceFromApi(row);
        setInvoiceData((prev) => prev.map((invoice) => (invoice.id === detailed.id ? detailed : invoice)));
      })
      .catch((error) => notify(error.message));
    return () => {
      cancelled = true;
    };
  }, [live, selectedInvoice?.apiId, setInvoiceData, notify]);

  const practiceEncounters = useMemo(
    () => encounters.filter((n) => practicePatientNames.has(n.patientName)),
    [encounters, practicePatientNames]
  );
  const practiceMessages = useMemo(
    () => messageLog.filter((m) => practicePatientNames.has(m.patient)),
    [messageLog, practicePatientNames]
  );
  const practiceQueue = useMemo(
    () => clinicalQueue.filter((q) => practicePatientNames.has(q.patient)),
    [practicePatientNames]
  );

  /** Open a chart, challenging for a reason when there is no care relationship. */
  /**
   * Open a chart.
   *
   * In live mode the decision is the server's: it answers 428 with the patient
   * named when only break-glass would allow it, and writes the audit entry
   * itself from the authenticated principal. The client does not evaluate
   * access and does not record the access — it asks, and reacts to the answer.
   * The seeded branch below reproduces that shape locally so the flow is the
   * same one either way.
   */
  const requestPatientFile = async (patient) => {
    if (live) {
      const result = await patientDirectory.open(patient);
      if (result.ok) {
        try {
          const [rows, documents, clinicalSummary] = await Promise.all([
            api.encounters.list(patient.patientId ?? patient.id),
            api.documents.list(patient.patientId ?? patient.id),
            access.can.viewClinicalNotes ? api.clinical.summary(patient.patientId ?? patient.id) : Promise.resolve(null),
          ]);
          setLiveEncounters((prev) => [
            ...prev.filter((note) => note.patientId !== patient.id),
            ...rows.map((row) => encounterFromApi(row, patient)),
          ]);
          setPatientRecords((prev) => ({
            ...prev,
            [patient.id]: {
              ...prev[patient.id],
              documents: documents.map(documentFromApi),
              prescriptions: (clinicalSummary?.prescriptions ?? []).map((row) => prescriptionFromApi(row)),
            },
          }));
        } catch (error) {
          notify(error.message);
        }
        openPatientFile(patient);
        return;
      }
      if (result.needsBreakGlass) {
        setBreakGlassReason('');
        setBreakGlassFor(patient);
        return;
      }
      notify(result.message);
      return;
    }

    const verdict = chartAccess(currentUser, patient, access, accessContext);
    if (verdict.decision === 'deny') {
      notify(verdict.reason);
      recordAudit({
        user: currentUser, action: 'Chart access denied', subject: patient.name,
        detail: verdict.reason, severity: AUDIT.ALERT,
      });
      return;
    }
    if (verdict.decision === 'break-glass') {
      setBreakGlassReason('');
      setBreakGlassFor(patient);
      return;
    }
    recordAudit({
      user: currentUser, action: 'Viewed chart', subject: patient.name,
      detail: verdict.relationship?.type, severity: AUDIT.INFO,
    });
    openPatientFile(patient);
  };

  const confirmBreakGlass = async () => {
    const patient = breakGlassFor;
    if (!patient || breakGlassReason.trim().length < 10) return;

    // Live mode retries the same request with the reason attached. The grant,
    // its expiry, and the flagged audit entry are all the server's to create —
    // a break-glass record written by the client would be a record of what the
    // client claims happened.
    if (live) {
      const result = await patientDirectory.open(patient, breakGlassReason.trim());
      if (!result.ok) {
        notify(result.message);
        return;
      }
      setBreakGlassFor(null);
      openPatientFile(patient);
      notify(`Break-glass access to ${patient.name} recorded in the audit log`);
      return;
    }

    setGrants((prev) => [
      ...prev,
      makeBreakGlassGrant({ user: currentUser, patient, reason: breakGlassReason.trim() }),
    ]);
    recordAudit({
      user: currentUser,
      action: 'Break-glass access',
      subject: patient.name,
      detail: breakGlassReason.trim(),
      severity: AUDIT.ALERT,
    });
    setBreakGlassFor(null);
    openPatientFile(patient);
    notify(`Break-glass access to ${patient.name} recorded in the audit log`);
  };
  // Global command palette — Ctrl/Cmd+K anywhere, the way staff actually navigate.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteQuery('');
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const paletteResults = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    const modules = navItems
      .filter((item) => access.views.includes(item.id))
      .map((item) => ({ kind: 'Module', label: item.label, hint: 'Go to module', run: () => setActiveView(item.id) }));

    // Search reaches the whole practice; opening still goes through the
    // relationship check, so the palette cannot bypass break-glass.
    const people = practicePatients.map((patient) => ({
      kind: 'Patient',
      label: patient.name,
      hint: `${patient.id} · ${patient.next}`,
      run: () => requestPatientFile(patient),
    }));

    const actions = [
      access.can.addPatient && { kind: 'Action', label: 'Register new patient', hint: 'Opens the intake form', run: () => openDialog('patient', { coverPlan: 'NH263 Plan A', preferredContact: 'SMS', emergencyRelationship: 'Spouse', provider: defaultProviderName, consentComms: true }) },
      access.can.scheduleVisit && { kind: 'Action', label: 'Schedule a visit', hint: 'Opens the booking form', run: () => openDialog('appointment', { provider: defaultProviderName, room: defaultRoomName, mode: 'In-person' }) },
      access.can.orderServices && { kind: 'Action', label: 'Order a service', hint: 'ECG, bloods, imaging', run: () => openDialog('order', { quantity: '1', priority: 'Routine' }) },
      access.can.createInvoice && { kind: 'Action', label: 'Raise an invoice', hint: 'Opens the billing form', run: () => openDialog('invoice') },
      access.can.recordPayment && { kind: 'Action', label: 'Look up a patient account', hint: 'Search for a statement and settle it', run: () => openStatement('') },
      access.can.sendMessages && { kind: 'Action', label: 'Send a patient message', hint: 'Opens the messaging form', run: () => openDialog('message', { channel: 'SMS', type: 'Manual message' }) },
    ].filter(Boolean);

    const all = [...actions, ...people, ...modules];
    if (!query) return all.slice(0, 8);
    return all.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query)).slice(0, 8);
    // `requestPatientFile` is recreated every render and is only invoked from a
    // click handler, so memoising against it would defeat the memo entirely
    // while changing nothing about behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, practicePatients, access]);

  const runPaletteItem = (item) => {
    setPaletteOpen(false);
    item.run();
  };

  // Alerts derived from live state, not a static list.
  const alerts = useMemo(() => {
    const list = [];
    // Overdue is a question about the calendar and the balance, so it is asked
    // of those rather than of a status string that was written when the invoice
    // was raised and never revisited.
    const overdue = practiceInvoices.filter((inv) => outstandingOn(inv) > 0 && (daysOverdue(inv) ?? 0) > 0);
    if (overdue.length) {
      const total = overdue.reduce((sum, inv) => sum + outstandingOn(inv), 0);
      list.push({ tone: 'alert', title: `${overdue.length} invoice${overdue.length > 1 ? 's' : ''} overdue · ${formatMoney(total)}`, detail: overdue.map((i) => `${i.patient} · ${daysOverdue(i)} days`).join(', '), go: () => setActiveView('billing') });
    }
    // Revenue that has already been earned and not yet asked for. This is the
    // leak a practice notices last, because nothing on the screen was missing.
    if (access.can.createInvoice && unbilledVisits.length) {
      list.push({
        tone: 'warm',
        title: `${unbilledVisits.length} completed visit${unbilledVisits.length > 1 ? 's' : ''} not yet billed`,
        detail: unbilledVisits.map((visit) => `${visit.patient} · ${visit.type}`).join(', '),
        go: () => setActiveView('appointments'),
      });
    }
    const rejected = practiceClaims.filter((claim) => claim.status === 'Rejected');
    if (rejected.length) {
      list.push({ tone: 'alert', title: `${rejected.length} claim rejected by NH263`, detail: rejected.map((c) => `${c.id} · ${c.patient}`).join(', '), go: () => setActiveView('claims') });
    }
    const unbooked = practicePatients.filter((patient) => patient.next === 'Not scheduled');
    if (unbooked.length) {
      list.push({ tone: 'warm', title: `${unbooked.length} patient${unbooked.length > 1 ? 's' : ''} without a next visit`, detail: unbooked.map((p) => p.name).join(', '), go: () => setActiveView('patients') });
    }
    const awaitingIntake = practicePatients.filter((patient) => patient.status === 'New');
    if (awaitingIntake.length) {
      list.push({ tone: 'neutral', title: `${awaitingIntake.length} awaiting clinical intake`, detail: awaitingIntake.map((p) => p.name).join(', '), go: () => setActiveView('patients') });
    }
    return list;
  }, [practiceInvoices, practiceClaims, practicePatients, unbilledVisits, access]);

  // Escape closes whichever is open. A menu that can only be dismissed with the
  // mouse is a menu a keyboard user cannot get out of.
  useEffect(() => {
    if (!headerMenu) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') closeHeaderMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [headerMenu]);

  /* ---------------------------------------------------------------------
   * URL synchronisation
   *
   * The URL is a projection of view state, not a second source of truth.
   * `buildRoute` derives the path from state; a hashchange listener applies
   * an incoming path back onto state. `appliedRoute` records the last path we
   * wrote or read so the two directions cannot chase each other in a loop.
   * ------------------------------------------------------------------- */
  const route = useHashRoute();
  const appliedRoute = useRef(null);

  const buildRoute = () => {
    switch (activeView) {
      case 'patients':
        return fileOpen
          ? ['patients', selectedPatientId, toSlug(patientFileTab)]
          : ['patients'];
      case 'clinical':
        return openNoteId ? ['clinical', 'notes', openNoteId] : ['clinical'];
      case 'appointments':
        return selectedAppointment?.id ? ['appointments', selectedAppointment.id] : ['appointments'];
      case 'billing':
        return selectedInvoice?.id ? ['billing', selectedInvoice.id] : ['billing'];
      case 'billing-handoff':
        return ['billing-handoff'];
      case 'claims':
        return selectedClaimId ? ['claims', selectedClaimId] : ['claims'];
      case 'ai':
        return ['ai', toSlug(aiTab)];
      case 'dashboard':
        return [];
      default:
        return [activeView];
    }
  };

  // State -> URL.
  //
  // Moving between modules, or in and out of a detail view, is a real
  // navigation and gets a history entry. Swapping which row is selected
  // inside the same view only rewrites the current entry — otherwise clicking
  // through eight appointments would cost eight presses of Back to escape.
  useEffect(() => {
    const segments = buildRoute();
    const target = buildHash(segments);
    const previous = appliedRoute.current;
    if (target === previous) return;

    const first = previous === null;
    const previousSegments = previous ? parseHash(previous) : [];
    const sameShape =
      !first &&
      previousSegments[0] === segments[0] &&
      previousSegments.length === segments.length;

    appliedRoute.current = target;
    navigate(segments, { replace: first || sameShape });
  });

  // URL -> state, for back/forward, a pasted link, or a bookmark.
  useEffect(() => {
    const incoming = buildHash(route);
    if (incoming === appliedRoute.current) return;
    appliedRoute.current = incoming;

    const [head, ...rest] = route;
    const view = head || 'dashboard';
    closeHeaderMenu();
    closeDialog();
    setShowPermissions(false);

    // A link into a module the current role cannot open falls back rather
    // than rendering a blank or leaking a restricted view.
    if (!access.views.includes(view)) {
      setActiveView('dashboard');
      return;
    }
    setActiveView(view);

    if (view === 'patients') {
      const [patientId, tabSlug] = rest;
      // A pasted link is an access request like any other. Resolve it against
      // the practice, then run the same relationship check the registry uses —
      // otherwise the URL bar becomes a way around tenancy and break-glass.
      const target = patientId ? practicePatients.find((p) => p.id === patientId) : null;
      if (!patientId) {
        setFileOpen(false);
      } else if (!target) {
        setFileOpen(false);
        if (patientRows.some((p) => p.id === patientId)) {
          recordAudit({
            user: currentUser, action: 'Chart access denied', subject: patientId,
            detail: 'Deep link to a patient in another practice', severity: AUDIT.ALERT,
          });
          notify('That patient belongs to another practice');
        }
      } else {
        const verdict = chartAccess(currentUser, target, access, accessContext);
        if (verdict.decision === 'allow') {
          setSelectedPatientId(target.id);
          setFileOpen(true);
          setPatientFileTab(fromSlug(tabSlug || 'summary', PATIENT_FILE_TABS));
        } else {
          setFileOpen(false);
          setBreakGlassReason('');
          setBreakGlassFor(target);
        }
      }
    } else if (view === 'clinical') {
      const noteId = rest[0] === 'notes' ? rest[1] : null;
      // Notes carry clinical content, so the same tenant check applies.
      const note = noteId ? encounters.find((n) => n.id === noteId) : null;
      const noteOk = note && practicePatients.some((p) => p.id === note.patientId);
      setOpenNoteId(noteOk ? noteId : null);
    } else if (view === 'appointments' && rest[0]) {
      const match = mockSchedule.find((a) => a.id === rest[0]);
      if (match) setSelectedAppointment(match);
    } else if (view === 'billing' && rest[0]) {
      const match = invoiceData.find((i) => i.id === rest[0]);
      if (match) setSelectedInvoice(match);
    } else if (view === 'claims' && rest[0]) {
      if (claims.some((c) => c.id === rest[0])) setSelectedClaimId(rest[0]);
    } else if (view === 'ai' && rest[0]) {
      setAiTab(fromSlug(rest[0], AI_TABS));
    }
    // Deliberately keyed on `route` alone. This is a route-to-state adapter,
    // not a reaction to data: re-running it whenever patients or notes change
    // would fight the state-to-URL effect above. The lookup collections are
    // still current whenever it does run, because the effect closure is
    // recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Distinguishable browser tabs — enterprise users keep several open.
  useEffect(() => {
    const module = navItems.find((item) => item.id === activeView);
    const detail =
      activeView === 'patients' && fileOpen ? ` · ${selectedPatient.name}`
      : activeView === 'clinical' && openNote ? ` · ${openNote.patientName} note`
      : '';
    document.title = `${module ? module.label : 'Overview'}${detail} · Luminary Health`;
  }, [activeView, fileOpen, selectedPatient, openNote]);


  const [aiTab, setAiTab] = useState('Agents');


  const submitClaimToSwitch = async (id) => {
    const pending = claims.find((c) => c.id === id);
    if (live) {
      try {
        await api.claims.submitCanonical(pending?.apiId || id, {
          submissionChannel: pending?.submissionChannel || 'MANUAL',
          idempotencyKey: `${pending?.apiId || id}:submit`,
        });
        await liveWorkspace.reload();
        notify(`${id} submitted through the claims gateway`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    // Refused here rather than by the switch a day later, while the person who
    // can fix it is still looking at the screen.
    if (pending && (!pending.icd10 || pending.icd10 === 'Not coded')) {
      notify(`${pending.id} has no diagnosis — the switch will reject it. Sign the encounter note first.`);
      return;
    }
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Submitted',
      responses: [
        ...claim.responses,
        { label: `Claim transmitted to NH263 switch · ${claim.amount}`, time: 'Just now', tone: 'success' },
        { label: 'Awaiting adjudication', time: 'Just now', tone: 'warm' },
      ],
    }));
  };

  const submitEmailClaim = (id) => {
    const pending = claims.find((c) => c.id === id);
    if (!pending) return;
    if (pending.status !== 'Client authenticated') {
      notify(`${pending.id} needs client authentication before email submission`);
      return;
    }
    updateClaim(id, (claim) => ({
      ...claim,
      status: 'Email submitted',
      externalReference: `EMAIL-${Date.now().toString().slice(-6)}`,
      emailSubmission: {
        ...(claim.emailSubmission || {}),
        sentAt: 'Just now',
        sentBy: currentUser.name,
        authentication: claim.emailSubmission?.authentication || `OTP declaration accepted by ${claim.patient}`,
      },
      responses: [
        ...(claim.responses || []),
        { label: `Claim pack emailed to ${claim.emailSubmission?.providerEmail || 'international provider'}`, time: 'Just now', tone: 'success' },
        { label: `Follow-up due: ${claim.emailSubmission?.followUp || '3 business days after submission'}`, time: 'Just now', tone: 'warm' },
      ],
    }));
    notify(`${id} emailed to ${pending.payerName || pending.plan || 'international provider'}`);
  };

  /**
   * The switch's answer.
   *
   * The other half of the round-trip that `submitClaimToSwitch` starts. The
   * screen has always promised that "adjudication response will post here in
   * real time" and nothing could produce one, so a submitted claim sat in
   * Submitted for ever and the rejection path below was unreachable. Stays a
   * local simulation until the NH263 proxy lands, exactly as capture and
   * submission are.
   */
  const recordAdjudication = async (id, outcome, rejectionCode) => {
    const claimToUpdate = claims.find((claim) => claim.id === id);
    if (live) {
      try {
        await api.claims.adjudicate(claimToUpdate?.apiId || id, {
          result: outcome === 'Rejected' ? 'REJECTED' : 'APPROVED',
          notes: outcome === 'Rejected'
            ? `${rejectionCode || 'Rejected'} ${REJECTION_REASONS[rejectionCode] ?? ''}`.trim()
            : 'Manual approval recorded',
        });
        await liveWorkspace.reload();
        notify(outcome === 'Rejected' ? `${id} rejected by NH263` : `${id} adjudicated`);
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    updateClaim(id, (claim) => ({
      ...claim,
      status: outcome === 'Rejected' ? 'Rejected' : 'Adjudicated',
      ...(outcome === 'Rejected' ? { rejectionCode } : {}),
      responses: [
        ...claim.responses,
        outcome === 'Rejected'
          ? { label: `Rejected: ${rejectionCode}, ${REJECTION_REASONS[rejectionCode] ?? 'declined by scheme'}`, time: 'Just now', tone: 'alert' }
          : { label: `Adjudicated: ${claim.amount} approved`, time: 'Just now', tone: 'success' },
      ],
    }));
    setInvoiceData((prev) => prev.map((invoice) => (
      invoice.claim === id ? { ...invoice, claimStatus: outcome === 'Rejected' ? 'Rejected' : 'Adjudicated' } : invoice
    )));
    notify(outcome === 'Rejected' ? `${id} rejected by NH263` : `${id} adjudicated`);
  };

  /**
   * Ask whether a declined claim should become the patient's debt.
   *
   * A rejection leaves the scheme portion booked as revenue that will never
   * arrive: the invoice under-states what is owed, and it ages in the wrong
   * bucket while the practice believes a payer is going to settle it.
   *
   * Deliberately proposed rather than performed. Rejections get appealed and
   * resubmitted with a corrected code all the time, and silently re-billing a
   * patient the moment the switch says no would chase people for money the
   * practice is still arguing about. The dialog states the amount and who ends
   * up owing it; a person commits it.
   */
  const proposePatientResponsibility = (claim) => {
    const invoice = invoiceData.find((i) => i.id === claim.invoice);
    if (!invoice) {
      notify(`${claim.id} has no invoice in this practice to move.`);
      return;
    }
    const declined = round2(invoice.services.reduce((sum, line) => sum + Number(line.insurance || 0), 0));
    if (declined <= 0) {
      notify("Nothing left with the scheme on this invoice — it is already the patient's.");
      return;
    }
    openDialog('rejection', {
      claimId: claim.id,
      invoiceId: invoice.id,
      patient: invoice.patient,
      declined,
      invoiceCurrency: invoice.currency ?? billingCurrency,
      alreadyOwed: invoice.patientResponsibility,
      rejectionCode: claim.rejectionCode ?? 'R204',
    });
  };

  const submitPatientResponsibility = (event) => {
    event.preventDefault();
    const invoice = invoiceData.find((i) => i.id === form.invoiceId);
    const claim = claims.find((c) => c.id === form.claimId);
    if (!invoice || !claim) return;

    const declined = round2(invoice.services.reduce((sum, line) => sum + Number(line.insurance || 0), 0));
    // The scheme's share is zeroed on the line and remembered, so the invoice
    // still says what was originally claimed rather than pretending the
    // practice always intended to bill the patient for all of it.
    const services = invoice.services.map((line) => ({
      ...line,
      insurance: 0,
      schemeDeclined: Number(line.insurance || 0) || undefined,
    }));

    const updated = settleStatus({
      ...invoice,
      services,
      patientResponsibility: round2(Number(invoice.patientResponsibility) + declined),
      claimStatus: 'Rejected',
    });

    setInvoiceData((prev) => prev.map((i) => (i.id === invoice.id ? updated : i)));
    // The registry balance is the gross invoice total, which has not changed —
    // the same money is owed, by someone else. Touching it here would double
    // count the patient's debt.
    updateClaim(claim.id, (existing) => ({
      ...existing,
      movedToPatient: true,
      responses: [
        ...existing.responses,
        { label: `Moved to patient responsibility · invoice ${invoice.id}`, time: 'Just now', tone: 'neutral' },
      ],
    }));
    setSelectedInvoice(updated);
    recordAudit({
      user: currentUser,
      action: 'Moved declined claim to patient responsibility',
      subject: invoice.id,
      detail: `${formatMoney(declined, updated.currency)} · ${claim.id} ${form.rejectionCode}`,
      severity: AUDIT.ALERT,
    });
    closeDialog();
    notify(`${formatMoney(declined, updated.currency)} moved to ${invoice.patient}`);
  };

  const currentDate = useMemo(() => {
    const date = new Date();
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(date);
  }, []);






  /** Doctor-first clinical workspace: the note editor, then the clinician's own day. */







  /**
   * Everything the extracted pages read. Pages are views over this; they never
   * hold state of their own beyond local UI concerns. When mutations move
   * behind a service layer, only the action functions below change.
   */
  const workspace = {
    // identity and access
    currentUser, practice, access, roleInfo, doctorIdentity, grants,
    // tenant-scoped collections
    practicePatients, myPatientList, practiceSchedule, todaysSchedule,
    practiceInvoices, practiceClaims, practiceEncounters, practiceEpisodes: episodes, practiceMessages, practiceQueue,
    // selection
    selectedPatient, selectedAppointment, selectedInvoice, selectedClaim,
    // billing
    receipt, setReceipt, outstandingOn, printReceipt, reprintReceipt,
    billingCurrency, formatMoney: money,
    openStatement, statementFor, daysOverdue, agingBucket,
    // audit
    auditLog, recordAudit,
    // actions
    setActiveView, openDialog, exportCsv, notify, currency, currentDate, currentRole,
    aiTab, setAiTab,
    settings, updateSettings, practiceUsers, updateUser, configuredProviders, configuredRooms,
    // catalogue and tariffs
    catalogue, configuredServices, tariffProvider, priceOn, triggerLabel, BILLING_TRIGGERS,
    repriceCatalogueService, payers: payerData,
    importBatches, publishTariffBatch, rollbackTariffBatch, publishServiceBatch,
    mappingProfiles, saveMappingProfile, addServiceAlias,
    // orders
    practiceOrders, billableOrders, advanceOrder, serviceForOrder,
    orderStatusTone, ORDER_STATUS, ORDER_PRIORITIES,
    showPermissions, setShowPermissions,
    // patients
    showWholePractice, setShowWholePractice, patientSearch, setPatientSearch,
    sortKey, setSortKey, setSelectedPatient, requestPatientFile, fileOpen, setFileOpen,
    patientRecords, patientFileTab, setPatientFileTab, savePatientRecord, notesForPatient, mergePatients,
    submitEpisode, updateEpisode, EPISODE_STATUSES,
    uploadPatientDocument, downloadPatientDocument, exportPatientFile, patientTab, setPatientTab, recordCompleteness,
    createPrescription,
    // scheduling
    setSelectedAppointment, moveAppointment, visitStatuses, advanceVisitStatus, markNoShow, cancelVisit,
    billVisit, unbilledVisits,
    // clinical
    openNote, setOpenNoteId, saveNote, signNote, addAddendum, completeTriage, openNoteForVisit, applyDictationEncounter,
    setSelectedInvoice, setSelectedClaimId, captureBiometric, submitClaimToSwitch,
    prepareEmailClaimForm, sendClaimForClientAuthentication, authenticateEmailClaim, submitEmailClaim,
    recordAdjudication, proposePatientResponsibility, REJECTION_REASONS,
  };

  const episodePatientName = form.patientName || practicePatients.find((patient) => patient.id === form.patientId)?.name || '';
  const episodeVisits = practiceSchedule.filter((visit) => visit.patient === episodePatientName);
  const episodeNotes = encounters.filter((note) => note.patientId === form.patientId || note.patientName === episodePatientName);
  const episodeOrders = practiceOrders.filter((order) => order.patientId === form.patientId || order.patientName === episodePatientName);
  const episodeInvoices = practiceInvoices.filter((invoice) => invoice.patient === episodePatientName);
  const episodeClaims = practiceClaims.filter((claim) => claim.patient === episodePatientName);

  const renderActiveView = () => {
    switch (activeView) {
      case 'settings':
        return access.views.includes('settings') ? <SettingsPage /> : <DashboardPage />;
      case 'audit':
        return <AuditPage />;
      case 'patients':
        return <PatientsPage />;
      case 'appointments':
        return <AppointmentsPage />;
      case 'billing':
        return <BillingPage />;
      case 'billing-handoff':
        return <BillingHandoffPage />;
      case 'clinical':
        return <ClinicalPage />;
      case 'orders':
        return <OrdersPage />;
      case 'tariffs':
        return <TariffImportPage />;
      case 'claims':
        return <ClaimsPage />;
      case 'communications':
        return <CommunicationsPage />;
      case 'ai':
        return <AIPage />;
      case 'reports':
        return <ReportsPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <>
      <div className="lh-app flex h-screen min-w-0 bg-canvas text-ink">
      <aside className={`${sidebarCollapsed ? 'w-[78px]' : 'w-[216px]'} relative hidden min-h-0 shrink-0 flex-col overflow-hidden border-r border-line bg-white/90 px-3 py-4 text-shell-on transition-all duration-200 lg:flex`}>
        <OceanWaveDecoration className="absolute -bottom-28 left-0 h-80 w-[158%] -translate-x-14 opacity-95" />
        <div className="relative flex items-center justify-between px-2 pb-4 pt-1">
          {sidebarCollapsed ? <LuminaryMark size={30} /> : <LuminaryLogo size={32} />}

          <button
            type="button"
            onClick={() => setSidebarCollapsed((value) => !value)}
            className="rounded-lg border border-line bg-white/80 p-1.5 text-muted transition hover:border-brand-edge hover:bg-brand-soft hover:text-brand"
            aria-label="Toggle sidebar"
          >
            <ChevronRight size={14} className={`transition ${sidebarCollapsed ? '' : 'rotate-180'}`} />
          </button>
        </div>

        <div className="relative mt-3 shrink-0 rounded-lg border border-line bg-surface/70 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]">
          {!sidebarCollapsed ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-2xs font-semibold uppercase tracking-[0.01em] text-brand-deep">Workspace</p>
                <p className="mt-1 text-xs font-semibold text-ink">{practice.short || practice.name}</p>
              </div>
              <button
                type="button"
                aria-label="Switch workspace"
                aria-expanded={headerMenu === 'workspace'}
                aria-haspopup="menu"
                onClick={() => {
                  if (isLive()) {
                    notify('Live workspace switching requires signing in to the target practice.');
                    return;
                  }
                  toggleHeaderMenu('workspace');
                }}
                className="relative z-40 rounded border border-line bg-white/80 p-1 text-muted transition hover:border-brand-edge hover:text-brand"
              >
                <ChevronDown size={14} className={`transition ${headerMenu === 'workspace' ? 'rotate-180' : ''}`} />
              </button>
            </div>
          ) : (
            <div className="flex justify-center">
              <div className="rounded-lg border border-line bg-white/80 p-2 text-brand">
                <Briefcase size={16} />
              </div>
            </div>
          )}

          {headerMenu === 'workspace' && !sidebarCollapsed && !isLive() && (
            <>
              <div className="fixed inset-0 z-30" onClick={closeHeaderMenu} aria-hidden="true" />
              <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-line/80 bg-white/95 shadow-[0_18px_42px_-18px_rgba(33,97,156,0.28)] backdrop-blur-xl">
                <div className="border-b border-line/70 px-3 py-2">
                  <p className="text-xs font-semibold text-ink">Switch practice</p>
                  <p className="mt-0.5 text-2xs text-muted">Demo tenant and role context</p>
                </div>
                <div className="p-1">
                  {demoPracticeOptions.map((option) => {
                    const active = option.id === currentUser.practiceId;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={active}
                        onClick={() => {
                          closeHeaderMenu();
                          onSwitchPractice?.(option.id);
                        }}
                        className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left transition ${
                          active ? 'cursor-default bg-brand-soft text-brand-deep' : 'text-ink-soft hover:bg-surface'
                        }`}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line bg-white text-brand">
                          {active ? <Check size={13} /> : <Briefcase size={13} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold">{option.short || option.name}</span>
                          <span className="block truncate text-2xs text-muted">
                            {option.switchUser?.fullName || 'No demo user'} | {option.location}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <nav className="relative mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-1 pr-1.5">
          {navItems.filter((item) => access.views.includes(item.id)).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveView(item.id)}
              className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium transition ${activeView === item.id ? 'bg-brand-soft text-brand-deep shadow-[0_8px_22px_-18px_rgba(8,114,222,0.55)]' : 'text-muted hover:bg-surface hover:text-ink'}`}
            >
              <item.icon size={16} strokeWidth={1.7} />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="relative mt-auto shrink-0 space-y-2 px-1 pb-2 pt-3">
          <button
            type="button"
            onClick={() => {
              if (access.views.includes('settings')) {
                setActiveView('settings');
              } else {
                notify('Settings are restricted to administrators.');
              }
            }}
            className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium transition ${activeView === 'settings' ? 'bg-brand-soft text-brand-deep shadow-[0_8px_22px_-18px_rgba(8,114,222,0.55)]' : 'text-muted hover:bg-surface hover:text-ink'}`}
          >
            <Settings size={16} strokeWidth={1.7} />
            {!sidebarCollapsed && <span>Settings</span>}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleHeaderMenu('user')}
              aria-expanded={headerMenu === 'user'}
              aria-haspopup="menu"
              className={`relative z-40 flex w-full items-center rounded-lg border border-transparent bg-white/25 transition hover:border-brand-edge/80 hover:bg-white/65 ${sidebarCollapsed ? 'justify-center p-2.5' : 'gap-2.5 px-2.5 py-3.5'}`}
            >
              <HumanAvatar initials={currentUser.initials} label={currentUser.fullName} className="h-8 w-8" />
              {!sidebarCollapsed && (
                <>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-2xs font-semibold leading-4 text-ink">{currentUser.fullName}</span>
                    <span className="block truncate text-2xs leading-3 text-muted">{roleInfo.label}</span>
                  </span>
                  <ChevronRight size={13} className={`shrink-0 text-muted transition ${headerMenu === 'user' ? 'rotate-90' : ''}`} />
                </>
              )}
            </button>

            {headerMenu === 'user' && (
              <>
                <div className="fixed inset-0 z-30" onClick={closeHeaderMenu} aria-hidden="true" />
                <div className="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-lg border border-line/80 bg-white/95 shadow-[0_18px_42px_-18px_rgba(33,97,156,0.28)] backdrop-blur-xl">
                  <div className="border-b border-line/70 p-3">
                    <p className="break-words text-xs font-semibold text-ink">{currentUser.fullName}</p>
                    <p className="mt-0.5 break-all text-2xs text-muted">{currentUser.email}</p>
                    {(currentUser.registration || currentUser.hpcz) && (
                      <p className="mt-1 text-2xs text-muted">
                        Registration {currentUser.registration || currentUser.hpcz}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-1.5 rounded bg-wash px-2 py-1.5">
                      <Briefcase size={12} className="text-brand" />
                      <span className="min-w-0 truncate text-2xs font-medium text-ink">{practice.name}</span>
                    </div>
                  </div>
                  <div className="p-1">
                    <button
                      type="button"
                      onClick={() => { closeHeaderMenu(); setShowPermissions(true); setActiveView('dashboard'); }}
                      className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                    >
                      My permissions
                    </button>
                    {!live && (
                      <button
                        type="button"
                        onClick={() => { closeHeaderMenu(); setResetOpen(true); }}
                          className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                      >
                        Reset demo data
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { closeHeaderMenu(); onLock(); }}
                      className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                    >
                      Lock session
                    </button>
                    <button
                      type="button"
                      onClick={() => { closeHeaderMenu(); onSignOut(); }}
                      className="w-full rounded px-2.5 py-1.5 text-left text-xs font-medium text-danger transition hover:bg-danger-soft"
                    >
                      Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <OceanWaveDecoration className="absolute bottom-0 left-0 h-64 w-full opacity-50" />
        <header className="relative z-20 flex shrink-0 items-center justify-between gap-3 border-b border-line/60 bg-white/58 px-4 py-2.5 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-line/70 bg-white/55 text-brand-deep">
              <Activity size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-2xs font-medium text-muted">{practice.short || practice.name}</p>
              <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-ink">
                {(navItems.find((item) => item.id === activeView) || navItems[0]).label}
              </h2>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => { setPaletteQuery(''); setPaletteOpen(true); }}
              className="hidden h-8 items-center gap-2 rounded-lg border border-line/70 bg-white/55 px-3 text-xs text-muted transition hover:border-brand-edge hover:bg-white/85 md:flex"
            >
              <Search size={14} />
              Search everything
              <kbd className="ml-1 rounded-sm border border-edge bg-white px-1.5 py-0.5 text-2xs font-medium text-muted">Ctrl K</kbd>
            </button>

            <button
              type="button"
              onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={darkMode ? 'Light mode' : 'Dark mode'}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-line/70 bg-white/55 text-body transition hover:border-brand-edge hover:bg-white/85"
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => toggleHeaderMenu('alerts')}
                aria-label={`Alerts: ${alerts.length} needing attention`}
                aria-expanded={headerMenu === 'alerts'}
                aria-haspopup="menu"
                className="relative z-40 flex h-8 w-8 items-center justify-center rounded-lg border border-line/70 bg-white/55 text-body transition hover:border-brand-edge hover:bg-white/85"
              >
                <Bell size={16} />
                {alerts.length > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold text-white">
                    {alerts.length}
                  </span>
                )}
              </button>

              {headerMenu === 'alerts' && (
                <>
                  <div className="fixed inset-0 z-30" onClick={closeHeaderMenu} aria-hidden="true" />
                  <div className="absolute right-0 z-40 mt-2 w-[min(340px,calc(100vw-2rem))] rounded-lg border border-line bg-white/95 shadow-[0_20px_48px_-16px_rgba(33,97,156,0.26)] backdrop-blur-xl">
                    <div className="border-b border-line px-4 py-3">
                      <p className="text-base font-semibold text-ink">Needs attention</p>
                      <p className="mt-0.5 text-xs text-muted">Derived from live billing, claims, and registry state</p>
                    </div>
                    <div className="max-h-[320px] overflow-y-auto p-2">
                      {alerts.length === 0 ? (
                        <p className="px-2 py-6 text-center text-sm text-muted">Nothing needs attention right now.</p>
                      ) : alerts.map((alert) => (
                        <button
                          key={alert.title}
                          type="button"
                          onClick={() => { alert.go(); closeHeaderMenu(); }}
                          className="flex w-full gap-2.5 rounded p-2.5 text-left transition hover:bg-surface"
                        >
                          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${alert.tone === 'alert' ? 'bg-danger-bright' : alert.tone === 'warm' ? 'bg-warning-bright' : 'bg-brand-bright'}`} />
                          <span>
                            <span className="block text-base font-medium text-ink">{alert.title}</span>
                            <span className="mt-0.5 block text-xs leading-4 text-muted">{alert.detail}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="relative md:hidden">
              <button
                type="button"
                onClick={() => toggleHeaderMenu('mobile-user')}
                aria-label="Account menu"
                aria-expanded={headerMenu === 'mobile-user'}
                aria-haspopup="menu"
                className="relative z-40 rounded-lg border border-line/70 bg-white/55 p-0.5 transition hover:border-brand-edge hover:bg-white/85"
              >
                <HumanAvatar initials={currentUser.initials} label={currentUser.fullName} className="h-7 w-7" />
              </button>

              {headerMenu === 'mobile-user' && (
                <>
                  <div className="fixed inset-0 z-30" onClick={closeHeaderMenu} aria-hidden="true" />
                  <div className="absolute right-0 z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line/80 bg-white/95 shadow-[0_18px_42px_-18px_rgba(33,97,156,0.28)] backdrop-blur-xl">
                    <div className="border-b border-line/70 p-3">
                      <p className="break-words text-xs font-semibold text-ink">{currentUser.fullName}</p>
                      <p className="mt-0.5 break-all text-2xs text-muted">{currentUser.email}</p>
                      <div className="mt-2 flex items-center gap-1.5 rounded bg-wash px-2 py-1.5">
                        <Briefcase size={12} className="text-brand" />
                        <span className="min-w-0 truncate text-2xs font-medium text-ink">{practice.name}</span>
                      </div>
                    </div>
                    <div className="p-1">
                      {access.views.includes('settings') && (
                        <button
                          type="button"
                          onClick={() => { closeHeaderMenu(); setActiveView('settings'); }}
                          className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                        >
                          Settings
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => { closeHeaderMenu(); setShowPermissions(true); setActiveView('dashboard'); }}
                        className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                      >
                        My permissions
                      </button>
                      <button
                        type="button"
                        onClick={() => { closeHeaderMenu(); onLock(); }}
                        className="w-full rounded px-2.5 py-1.5 text-left text-xs text-ink-soft transition hover:bg-surface"
                      >
                        Lock session
                      </button>
                      <button
                        type="button"
                        onClick={() => { closeHeaderMenu(); onSignOut(); }}
                        className="w-full rounded px-2.5 py-1.5 text-left text-xs font-medium text-danger transition hover:bg-danger-soft"
                      >
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <nav className="relative z-20 flex shrink-0 gap-1 overflow-x-auto border-b border-line/60 bg-white/70 px-3 py-2 backdrop-blur lg:hidden">
          {navItems.filter((item) => access.views.includes(item.id)).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveView(item.id)}
              className={`flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition sm:gap-2 sm:px-3 sm:text-sm ${activeView === item.id ? 'bg-brand text-white shadow-[0_8px_20px_-16px_rgba(8,114,222,0.55)]' : 'text-body hover:bg-surface hover:text-ink'}`}
            >
              <item.icon size={15} strokeWidth={1.7} />
              <span>{item.label}</span>
            </button>
          ))}
          {access.views.includes('settings') && (
            <button
              type="button"
              onClick={() => setActiveView('settings')}
              className={`flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition sm:gap-2 sm:px-3 sm:text-sm ${activeView === 'settings' ? 'bg-brand text-white shadow-[0_8px_20px_-16px_rgba(8,114,222,0.55)]' : 'text-body hover:bg-surface hover:text-ink'}`}
            >
              <Settings size={15} strokeWidth={1.7} />
              <span>Settings</span>
            </button>
          )}
        </nav>

        {/* Patient context follows the user across modules — clinicians must always
            know whose record is in focus before they act on it. */}
        {['patients', 'clinical', 'claims', 'billing'].includes(activeView) && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-white/70 px-4 py-2.5 backdrop-blur sm:px-6">
            <div className="flex items-center gap-2.5">
              <HumanAvatar
                initials={selectedPatient.name.split(' ').map((part) => part[0]).join('')}
                label={selectedPatient.name}
                className="h-7 w-7"
              />
              <div>
                <p className="text-base font-semibold leading-tight text-ink">{selectedPatient.name}</p>
                <p className="text-xs leading-tight text-muted">{selectedPatient.id} · {String(selectedPatient.memberNo ?? '').replace(/Self-pay/g, 'Self pay')}</p>
              </div>
            </div>
            <span className="hidden h-6 w-px bg-edge-strong sm:block" />
            <p className="text-xs text-muted">Next visit <span className="font-medium text-ink">{selectedPatient.next}</span></p>
            <p className="text-xs text-muted">Balance <span className="font-medium text-ink">{currency(selectedPatient.balance)}</span></p>
            <p className="text-xs text-muted">Provider <span className="font-medium text-ink">{selectedPatient.provider}</span></p>
            <StatusPill label={selectedPatient.status} tone={patientStatusTone[selectedPatient.status]} />

            {/* Say on what grounds this chart is open. Break-glass is called
                out loudly, because the user should never forget they are in it. */}
            {(() => {
              const rel = careRelationship(currentUser, selectedPatient, accessContext);
              if (!rel) return null;
              const isBreakGlass = rel.type === RELATIONSHIP.BREAK_GLASS;
              return (
                <span
                  title={rel.detail}
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-2xs font-semibold uppercase tracking-[0.08em] ${
                    isBreakGlass ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand-deep'
                  }`}
                >
                  {isBreakGlass && <AlertTriangle size={10} />}
                  {rel.type}
                </span>
              );
            })()}

            <button
              type="button"
              onClick={() => { setPaletteQuery(''); setPaletteOpen(true); }}
              className="text-xs font-medium text-brand hover:underline sm:ml-auto"
            >
              Switch patient
            </button>
          </div>
        )}

        <div className="relative z-10 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:px-8 lg:py-6">
          <WorkspaceProvider value={workspace}>{renderActiveView()}</WorkspaceProvider>
        </div>
      </main>

      <Modal
        open={dialog === 'patient'}
        onClose={closeDialog}
        title="Register new patient"
        subtitle="Identity, contact, next of kin, and cover are captured at registration. Clinical intake follows in the patient file."
        width="max-w-3xl"
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="patient-form">Register patient</Button>
        </>}
      >
        <form id="patient-form" onSubmit={submitNewPatient} className="space-y-5">
          <fieldset>
            <legend className="mb-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-brand">Identity</legend>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Field label="Full name" required error={formErrors.name}>
                  <Input value={form.name || ''} onChange={setField('name')} placeholder="e.g. Rudo Chikafu" />
                </Field>
              </div>
              <Field label="Date of birth" required error={formErrors.dob} hint={form.dob && !formErrors.dob ? `${ageFromDob(form.dob)} years old` : undefined}>
                <Input type="date" value={form.dob || ''} onChange={setField('dob')} />
              </Field>
              <Field label="Sex" required error={formErrors.sex}>
                <Select value={form.sex || ''} onChange={setField('sex')} options={['', ...SEX_OPTIONS]} />
              </Field>
              <Field label="National ID" required error={formErrors.nationalId}>
                <Input value={form.nationalId || ''} onChange={setField('nationalId')} placeholder="63-0000000-A-00" />
              </Field>
              <Field label="Occupation">
                <Input value={form.occupation || ''} onChange={setField('occupation')} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-brand">Contact</legend>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Primary phone" required error={formErrors.phone}>
                <Input value={form.phone || ''} onChange={setField('phone')} placeholder="+263 …" />
              </Field>
              <Field label="Email" error={formErrors.email}>
                <Input type="email" value={form.email || ''} onChange={setField('email')} />
              </Field>
              <Field label="Preferred contact">
                <Select value={form.preferredContact || 'SMS'} onChange={setField('preferredContact')} options={CONTACT_METHODS} />
              </Field>
              <Field label="Street"><Input value={form.addressStreet || ''} onChange={setField('addressStreet')} /></Field>
              <Field label="Suburb"><Input value={form.addressSuburb || ''} onChange={setField('addressSuburb')} /></Field>
              <Field label="City" required error={formErrors.addressCity}>
                <Input value={form.addressCity || ''} onChange={setField('addressCity')} placeholder="Harare" />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-brand">Next of kin</legend>
            <div className="grid gap-3.5 sm:grid-cols-3">
              <Field label="Name" required error={formErrors.emergencyName}>
                <Input value={form.emergencyName || ''} onChange={setField('emergencyName')} />
              </Field>
              <Field label="Relationship">
                <Select value={form.emergencyRelationship || 'Spouse'} onChange={setField('emergencyRelationship')} options={RELATIONSHIPS} />
              </Field>
              <Field label="Phone" required error={formErrors.emergencyPhone}>
                <Input value={form.emergencyPhone || ''} onChange={setField('emergencyPhone')} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-brand">Cover and care team</legend>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Cover plan" required>
                <Select value={form.coverPlan || 'NH263 Plan A'} onChange={setField('coverPlan')} options={COVER_PLANS} />
              </Field>
              <Field label="Member number" required={form.coverPlan !== 'Self-pay'} error={formErrors.memberNo} hint={form.coverPlan === 'Self-pay' ? 'Not needed for self pay' : undefined}>
                <Input value={form.memberNo || ''} onChange={setField('memberNo')} placeholder="NH263-000000-00" disabled={form.coverPlan === 'Self-pay'} />
              </Field>
              <Field label="Dependant code" hint="00 for the principal member">
                <Input value={form.dependantCode || ''} onChange={setField('dependantCode')} placeholder="00" />
              </Field>
              <Field label="Assigned provider" required>
                <Select value={form.provider || defaultProviderName} onChange={setField('provider')} options={configuredProviders.length ? configuredProviders : ['Unassigned']} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-brand">Consent</legend>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 text-base text-ink">
                <input type="checkbox" checked={!!form.consentTreatment} onChange={(e) => setForm((p) => ({ ...p, consentTreatment: e.target.checked }))} className="mt-0.5 h-4 w-4 accent-brand" />
                <span>
                  Consent to treatment <span className="text-danger">*</span>
                  {formErrors.consentTreatment && <span className="mt-0.5 block text-xs text-danger">{formErrors.consentTreatment}</span>}
                </span>
              </label>
              <label className="flex items-center gap-2.5 text-base text-ink">
                <input type="checkbox" checked={!!form.consentComms} onChange={(e) => setForm((p) => ({ ...p, consentComms: e.target.checked }))} className="h-4 w-4 accent-brand" />
                Consent to SMS, WhatsApp, and email reminders
              </label>
              <label className="flex items-center gap-2.5 text-base text-ink">
                <input type="checkbox" checked={!!form.consentDataSharing} onChange={(e) => setForm((p) => ({ ...p, consentDataSharing: e.target.checked }))} className="h-4 w-4 accent-brand" />
                Consent to share records with referred providers
              </label>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={dialog === 'episode'}
        onClose={closeDialog}
        title={form.id ? 'Edit episode' : 'Start new episode'}
        subtitle={episodePatientName || 'Patient episode'}
        width="max-w-4xl"
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="episode-form">{form.id ? 'Save episode' : 'Start episode'}</Button>
        </>}
      >
        <form id="episode-form" onSubmit={submitEpisode} className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Episode title" required error={formErrors.title}>
              <Input value={form.title || ''} onChange={setField('title')} placeholder="e.g. Hypertension management" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Reason">
              <Textarea value={form.reason || ''} onChange={setField('reason')} placeholder="Why this episode exists" />
            </Field>
          </div>
          <Field label="Start date" required error={formErrors.startDate}>
            <Input type="date" value={form.startDate || new Date().toISOString().slice(0, 10)} onChange={setField('startDate')} />
          </Field>
          <Field label="Status">
            <Select value={form.status || 'Active'} onChange={setField('status')} options={EPISODE_STATUSES} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Primary diagnosis" required error={formErrors.primaryDiagnosis}>
              <Input value={form.primaryDiagnosis || ''} onChange={setField('primaryDiagnosis')} placeholder="e.g. I10 Essential hypertension" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Outcome / closure note">
              <Textarea value={form.outcome || ''} onChange={setField('outcome')} placeholder="Current outcome, closure reason, or next clinical target" />
            </Field>
          </div>

          <EpisodeLinkPicker
            title="Linked visits"
            items={episodeVisits.map((visit) => ({
              id: visit.id,
              label: `${visit.time} | ${visit.type}`,
              detail: `${visit.provider} | ${visit.room || visit.mode || 'No room'}`,
            }))}
            selected={form.linkedVisitIds || []}
            onToggle={(id) => toggleFormList('linkedVisitIds', id)}
            empty="No visits for this patient yet."
          />
          <EpisodeLinkPicker
            title="Linked notes"
            items={episodeNotes.map((note) => ({
              id: note.id,
              label: `${note.date} | ${note.type}`,
              detail: `${note.status} | ${note.provider}`,
            }))}
            selected={form.linkedNoteIds || []}
            onToggle={(id) => toggleFormList('linkedNoteIds', id)}
            empty="No notes for this patient yet."
          />
          <EpisodeLinkPicker
            title="Linked orders"
            items={episodeOrders.map((order) => ({
              id: order.id,
              label: `${order.id} | ${order.serviceName}`,
              detail: `${order.status} | ${order.department} | ${order.priority}`,
            }))}
            selected={form.linkedOrderIds || []}
            onToggle={(id) => toggleFormList('linkedOrderIds', id)}
            empty="No orders for this patient yet."
          />
          <EpisodeLinkPicker
            title="Linked invoices"
            items={episodeInvoices.map((invoice) => ({
              id: invoice.id,
              label: `${invoice.id} | ${formatMoney(invoice.amount, invoice.currency)}`,
              detail: `${invoice.claimStatus || 'Draft'} | ${invoice.date || invoice.issuedOn || 'No date'}`,
            }))}
            selected={form.linkedInvoiceIds || []}
            onToggle={(id) => toggleFormList('linkedInvoiceIds', id)}
            empty="No invoices for this patient yet."
          />
          <EpisodeLinkPicker
            title="Linked claims"
            items={episodeClaims.map((claim) => ({
              id: claim.id,
              label: `${claim.id} | ${claim.status}`,
              detail: claim.plan || claim.payerName || claim.channel || 'No payer',
            }))}
            selected={form.linkedClaimIds || []}
            onToggle={(id) => toggleFormList('linkedClaimIds', id)}
            empty="No claims for this patient yet."
          />
        </form>
      </Modal>

      <Modal
        open={dialog === 'appointment'}
        onClose={closeDialog}
        title="Schedule a visit"
        subtitle="Double booking a provider at the same time is blocked."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="appointment-form">Book visit</Button>
        </>}
      >
        <form id="appointment-form" onSubmit={submitAppointment} className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Patient" required error={formErrors.patient}>
              <PatientPicker
                patients={practicePatients}
                value={form.patient || ''}
                onChange={setValue('patient')}
              />
            </Field>
          </div>
          <Field label="Visit origin">
            <Select value={form.origin || 'scheduled'} onChange={setField('origin')} options={['scheduled', 'walk_in']} render={(value) => value === 'walk_in' ? 'Walk-in' : 'Scheduled'} />
          </Field>
          <Field label="Time" required={(form.origin || 'scheduled') === 'scheduled'} error={formErrors.time}>
            <Input type="time" value={form.time || ''} onChange={setField('time')} disabled={(form.origin || 'scheduled') === 'walk_in'} />
          </Field>
          <Field label="Duration" hint="Shown to scale on the calendar">
            <Select value={form.duration || '30'} onChange={setField('duration')} options={['15', '30', '45', '60', '90']} />
          </Field>
          <Field label="Provider" error={formErrors.provider}>
            <Select value={(form.origin || 'scheduled') === 'walk_in' ? 'Unassigned' : (form.provider || defaultProviderName)} onChange={setField('provider')} options={(form.origin || 'scheduled') === 'walk_in' ? ['Unassigned', ...configuredProviders] : (configuredProviders.length ? configuredProviders : ['Unassigned'])} />
          </Field>
          <Field label="Room">
            <Select value={form.room || defaultRoomName} onChange={setField('room')} options={configuredRooms.length ? configuredRooms : ['Unassigned']} />
          </Field>
          <Field label="Visit type">
            <Input value={form.type || ''} onChange={setField('type')} placeholder="e.g. Follow-up" />
          </Field>
          <Field label="Mode">
            <Select value={form.mode || 'In-person'} onChange={setField('mode')} options={['In-person', 'Telehealth']} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Day">
              <Select
                value={String(form.day ?? 0)}
                onChange={setField('day')}
                options={['0', '1', '2', '3', '4', '5']}
              />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={dialog === 'invoice'}
        onClose={closeDialog}
        title="Raise an invoice"
        subtitle="Pick a service, choose how the price is set, then confirm the invoice line."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="invoice-form">Create invoice</Button>
        </>}
      >
        <form id="invoice-form" onSubmit={submitInvoice} className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Patient" required error={formErrors.patient}>
              <PatientPicker patients={practicePatients} value={form.patient || ''} onChange={setValue('patient')} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Service" required error={formErrors.service} hint="Type the service exactly as it should appear on the invoice.">
              <Input
                value={form.service || ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setForm((prev) => ({
                    ...prev,
                    service: value,
                    serviceId: '',
                    standardAmount: '',
                    pricingMode: prev.pricingMode === 'Standard price' ? 'Custom price' : prev.pricingMode,
                  }));
                }}
                placeholder="e.g. Wound dressing with consumables"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Catalogue match" hint="Optional. Pick one only when this line should use a saved service and standard price.">
              <Select
                value={form.serviceId || ''}
                onChange={(event) => selectService(event.target.value)}
                options={['', ...configuredServices.map((svc) => svc.id)]}
                render={(id) => {
                  const svc = serviceById(catalogue, id);
                  if (!svc) return 'Choose a service…';
                  const price = priceOn(svc);
                  return `${svc.displayName} · ${svc.department} · ${price ? formatMoney(price.amount, price.currency) : 'Not priced'}`;
                }}
              />
            </Field>
          </div>
          <Field label="Tariff code">
            <Input value={form.code || ''} onChange={setField('code')} placeholder="99213" />
          </Field>
          <Field label="Pricing">
            <Select
              value={form.serviceId ? (form.pricingMode || 'Standard price') : 'Custom price'}
              onChange={(event) => {
                const pricingMode = event.target.value;
                setForm((prev) => ({
                  ...prev,
                  pricingMode,
                  amount: pricingMode === 'Standard price' && prev.standardAmount ? prev.standardAmount : prev.amount,
                  priceReason: pricingMode === 'Standard price' ? '' : prev.priceReason,
                  priceNote: pricingMode === 'Standard price' ? '' : prev.priceNote,
                }));
              }}
              options={form.serviceId ? PRICING_MODES : ['Custom price']}
            />
          </Field>
          <Field label="Standard price">
            <Input value={form.standardAmount ? formatMoney(Number(form.standardAmount), billingCurrency) : 'No standard price'} disabled />
          </Field>
          <div className="sm:col-span-2">
            {/* The split this patient will actually be billed at. This hint
                used to hardcode 80% while the handler applied the scheme rate,
                so the preview and the saved invoice disagreed for everyone not
                on an 80% plan — and reception was reading the preview. */}
            <Field
              label={`Amount (${billingCurrency})`}
              required
              error={formErrors.amount}
              /*
               * The estimated split, resolved the same way the saved invoice
               * will resolve it — same catalogue, same tariff provider, same
               * date. The preview and the record cannot disagree because they
               * are the same call.
               */
              hint={(() => {
                const patient = practicePatients.find((p) => p.name === form.patient);
                const plan = coverPlanFor(patient);
                const value = Number(form.amount);
                if (!form.patient) return 'Choose a patient to see how their scheme splits this.';
                if (!form.amount || Number.isNaN(value)) return plan;

                const service = serviceById(catalogue, form.serviceId);
                const priced = service
                  ? priceServiceFor({ ...service, price: [{ amount: value, currency: billingCurrency, effectiveFrom: '2000-01-01', effectiveTo: null }] }, patient)
                  : null;
                if (priced) {
                  return `${plan} · estimated ${formatMoney(priced.estimatedFunder, billingCurrency)}, patient ${formatMoney(priced.estimatedPatient, billingCurrency)} (${priced.tariffVia})`;
                }
                const { plan: resolved } = coverFor(patient);
                const insured = resolved ? round2(value * (resolved.reimbursePercent / 100)) : 0;
                return `${plan} · estimated ${formatMoney(insured, billingCurrency)}, patient ${formatMoney(round2(value - insured), billingCurrency)}`;
              })()}
            >
              <Input
                type="number"
                min="1"
                step="0.01"
                value={form.amount || ''}
                onChange={setField('amount')}
                placeholder="0.00"
                disabled={form.serviceId && (form.pricingMode || 'Standard price') === 'Standard price'}
              />
            </Field>
          </div>
          {(form.serviceId ? (form.pricingMode || 'Standard price') : 'Custom price') !== 'Standard price' && (
            <>
              <Field label="Price reason" required error={formErrors.priceReason}>
                <Select value={form.priceReason || ''} onChange={setField('priceReason')} options={['', ...PRICE_OVERRIDE_REASONS]} />
              </Field>
              <Field label="Price note" required={form.priceReason === 'Other'} error={formErrors.priceNote}>
                <Input value={form.priceNote || ''} onChange={setField('priceNote')} placeholder="e.g. Large dressing kit and after-hours visit" />
              </Field>
            </>
          )}
        </form>
      </Modal>

      <Modal
        open={dialog === 'payment'}
        onClose={closeDialog}
        title="Record a payment"
        subtitle="Cash and EcoCash at the desk are the normal case, so this is a first-class action."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="payment-form">Take payment</Button>
        </>}
      >
        <form id="payment-form" onSubmit={submitPayment} className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2 rounded border border-line bg-surface p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{form.patient} · {form.invoiceId}</span>
              <span className="text-base font-medium text-ink">
                {formatMoney(form.outstanding ?? 0, form.invoiceCurrency || billingCurrency)} outstanding
              </span>
            </div>
          </div>

          <Field label="Amount tendered" required error={formErrors.amount}>
            <Input type="number" min="0" step="0.01" value={form.amount || ''} onChange={setField('amount')} placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <Select value={form.currency || billingCurrency} onChange={setField('currency')} options={CURRENCIES} />
          </Field>

          {(form.currency || billingCurrency) !== (form.invoiceCurrency || billingCurrency) && (
            <div className="sm:col-span-2">
              <Field
                label={`Rate for 1 ${form.currency} in ${form.invoiceCurrency || billingCurrency}`}
                required
                hint="The rate at the moment of payment is stored with it, so the receipt never changes when the rate does."
              >
                <Input type="number" min="0" step="0.0001" value={form.fxRate || ''} onChange={setField('fxRate')} placeholder="0.0000" />
              </Field>
            </div>
          )}

          <div className="sm:col-span-2">
            <Field label="Method">
              <Select
                value={form.method || 'cash'}
                onChange={setField('method')}
                options={PAYMENT_METHODS.map((m) => m.value)}
              />
            </Field>
          </div>

          {/* What will actually be applied, before anyone commits to it. */}
          {form.amount && !Number.isNaN(Number(form.amount)) && (
            <div className="sm:col-span-2 rounded border border-edge bg-white p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted">Applied to invoice</span>
                <span className="font-medium text-ink">
                  {formatMoney(
                    Math.round(Number(form.amount) * Number((form.currency || billingCurrency) === (form.invoiceCurrency || billingCurrency) ? 1 : form.fxRate || 0) * 100) / 100,
                    form.invoiceCurrency || billingCurrency
                  )}
                </span>
              </div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={dialog === 'reversal'}
        onClose={closeDialog}
        title="Reverse a payment"
        subtitle="Written as a counter entry. The original stays on the ledger."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="reversal-form">Reverse payment</Button>
        </>}
      >
        <form id="reversal-form" onSubmit={submitReversal} className="space-y-3.5">
          <div className="rounded border border-line bg-surface p-3 text-sm">
            <p className="text-muted">Reversing</p>
            <p className="mt-1 text-base font-medium text-ink">
              {formatMoney(form.amount ?? 0, form.currency || billingCurrency)} · {form.invoiceId}
            </p>
          </div>
          <Field
            label="Reason"
            required
            error={formErrors.reason}
            hint="Recorded in the audit log at alert severity, against your name."
          >
            <Textarea value={form.reason || ''} onChange={setField('reason')} placeholder="e.g. Taken against the wrong invoice at reception" />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === 'order'}
        onClose={closeDialog}
        title="Order a service"
        subtitle="Clinical intent. Nothing is billed until the work is actually done."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="order-form">Place order</Button>
        </>}
      >
        <form id="order-form" onSubmit={placeOrder} className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Patient" required error={formErrors.patient}>
              <PatientPicker patients={practicePatients} value={form.patient || ''} onChange={setValue('patient')} />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Service" required error={formErrors.serviceId}>
              <Select
                value={form.serviceId || ''}
                onChange={setField('serviceId')}
                options={['', ...configuredServices.map((svc) => svc.id)]}
                render={(id) => {
                  const svc = serviceById(catalogue, id);
                  return svc ? `${svc.displayName} · ${svc.department}` : 'Choose a service…';
                }}
              />
            </Field>
          </div>

          <Field label="Quantity">
            <Input type="number" min="1" value={form.quantity || '1'} onChange={setField('quantity')} />
          </Field>
          <Field label="Priority">
            <Select value={form.priority || 'Routine'} onChange={setField('priority')} options={ORDER_PRIORITIES} />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Clinical note" hint="Why this is being requested. Goes to whoever performs it.">
              <Textarea value={form.clinicalNotes || ''} onChange={setField('clinicalNotes')} placeholder="e.g. Palpitations on exertion" />
            </Field>
          </div>

          {/* What it will cost, shown to whoever is ordering — but only as
              information. A clinician is never asked to choose a tariff. */}
          {form.serviceId && form.patient && (() => {
            const service = serviceById(catalogue, form.serviceId);
            const patient = practicePatients.find((p) => p.name === form.patient);
            const priced = service && patient
              ? priceServiceFor(service, patient, { quantity: Number(form.quantity) || 1 })
              : null;
            if (!priced) return null;
            return (
              <div className="sm:col-span-2 rounded border border-edge bg-white p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">{coverPlanFor(patient)}</span>
                  <span className="tabular-nums text-ink">
                    {formatMoney(priced.gross, billingCurrency)}
                    {' · est. patient '}
                    <span className="font-medium">{formatMoney(priced.estimatedPatient, billingCurrency)}</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-body">
                  Billed {triggerLabel(service.billingTrigger).toLowerCase()} · {priced.tariffVia}
                </p>
              </div>
            );
          })()}
        </form>
      </Modal>

      <Modal
        open={dialog === 'prescription'}
        onClose={closeDialog}
        title="New prescription"
        subtitle={form.patient ? `${form.patient.name} · ${form.patient.id}` : undefined}
        width="max-w-2xl"
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="prescription-form">Issue prescription</Button>
        </>}
      >
        {form.patient && (() => {
          const record = patientRecords[form.patient.id];
          return (
            <form id="prescription-form" onSubmit={submitPrescription} className="space-y-4">
              <div className="rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <p className="text-ink"><span className="text-muted">Patient:</span> <strong>{form.patient.name}</strong> · {form.patient.id}</p>
                  <p className="text-ink"><span className="text-muted">DOB / sex:</span> {record?.dob || 'Not recorded'} · {record?.sex || 'Not recorded'}</p>
                  <p className="text-ink"><span className="text-muted">Prescriber:</span> {roleInfo.person ?? currentUser.name}</p>
                  <p className="text-ink"><span className="text-muted">Current medications:</span> {record?.medications?.length ? record.medications.join(', ') : 'None recorded'}</p>
                  <p className="text-ink"><span className="text-muted">Active conditions:</span> {record?.conditions?.length ? record.conditions.join(', ') : 'None recorded'}</p>
                </div>
                <p className={`mt-2 font-medium ${record?.allergies?.length ? 'text-danger' : 'text-muted'}`}>
                  {record?.allergiesRecorded
                    ? record?.allergies?.length ? `Allergies: ${record.allergies.join('; ')}` : 'Allergies: none known'
                    : '⚠ Allergies not yet reviewed for this patient'}
                </p>
              </div>

              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Medication" required error={formErrors.drug}>
                    <Input value={form.drug || ''} onChange={setField('drug')} placeholder="e.g. Amoxicillin" />
                  </Field>
                </div>
                <Field label="Form">
                  <Select
                    value={form.form || ''}
                    onChange={setField('form')}
                    options={['', 'tablet', 'capsule', 'cream', 'inhaler', 'syrup', 'injection', 'drops', 'ointment']}
                    render={(v) => v || 'Choose a form…'}
                  />
                </Field>
                <Field label="Strength" required error={formErrors.strength}>
                  <Input value={form.strength || ''} onChange={setField('strength')} placeholder="e.g. 500 mg" />
                </Field>
                <Field label="Dose">
                  <Input value={form.dose || ''} onChange={setField('dose')} placeholder="e.g. 1 capsule" />
                </Field>
                <Field label="Route" required error={formErrors.route}>
                  <Select
                    value={form.route || ''}
                    onChange={setField('route')}
                    options={['', 'oral', 'topical', 'IM', 'IV', 'subcutaneous', 'inhaled', 'rectal', 'ophthalmic', 'other']}
                    render={(v) => v || 'Choose a route…'}
                  />
                </Field>
                <Field label="Frequency / directions" required error={formErrors.frequency}>
                  <Input value={form.frequency || ''} onChange={setField('frequency')} placeholder="e.g. three times daily" />
                </Field>
                <Field label="Duration (days)" required error={formErrors.durationDays}>
                  <Input type="number" min="1" value={form.durationDays || ''} onChange={setField('durationDays')} />
                </Field>
                <Field label="Quantity to dispense">
                  <Input type="number" min="1" value={form.quantity || ''} onChange={setField('quantity')} />
                </Field>
                <Field label="Refills" hint="0–12">
                  <Input type="number" min="0" max="12" value={form.refills ?? '0'} onChange={setField('refills')} />
                </Field>
                <Field label="Substitution">
                  <Select
                    value={form.substitutionAllowed ?? ''}
                    onChange={setField('substitutionAllowed')}
                    options={['', 'true', 'false']}
                    render={(v) => (v === 'true' ? 'Substitution allowed' : v === 'false' ? 'Do not substitute' : 'Per pharmacist judgement')}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Indication" hint="Optional but recommended">
                    <Input value={form.indication || ''} onChange={setField('indication')} placeholder="e.g. Acute bacterial sinusitis" />
                  </Field>
                </div>
                <Field label="Pharmacy" hint="Optional">
                  <Input value={form.pharmacy || ''} onChange={setField('pharmacy')} placeholder="Dispense at patient pharmacy" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Additional instructions" hint="Optional">
                    <Textarea value={form.instructions || ''} onChange={setField('instructions')} placeholder="e.g. Take after food" />
                  </Field>
                </div>
              </div>

              {!record?.allergiesRecorded && (
                <label className="flex items-center gap-2 text-sm text-body">
                  <input
                    type="checkbox"
                    checked={Boolean(form.allergiesReviewed)}
                    onChange={(event) => setForm((prev) => ({ ...prev, allergiesReviewed: event.target.checked }))}
                    className="h-4 w-4 accent-brand"
                  />
                  I have reviewed this patient&apos;s allergies before prescribing
                </label>
              )}
              {formErrors.allergiesReviewed && (
                <p className="text-sm text-danger">{formErrors.allergiesReviewed}</p>
              )}
              {formErrors.submit && (
                <div className="rounded border border-danger-strong bg-danger-soft p-3 text-sm text-danger">
                  {formErrors.submit}
                </div>
              )}
            </form>
          );
        })()}
      </Modal>

      <Modal
        open={dialog === 'prescriptionDictation'}
        onClose={closeDialog}
        title="Dictate prescription"
        subtitle={form.patient ? `${form.patient.name} · ${form.patient.id}` : undefined}
        width="max-w-2xl"
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          {form.dictationId
            ? <Button type="submit" form="prescription-dictation-approve-form">Approve prescription</Button>
            : <Button type="submit" form="prescription-dictation-transcript-form" disabled={form.structuring}>
                {form.structuring ? 'Structuring…' : 'Structure'}
              </Button>}
        </>}
      >
        {form.patient && (() => {
          const record = patientRecords[form.patient.id];
          return (
            <div className="space-y-4">
              <div className="rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <p className="text-ink"><span className="text-muted">Patient:</span> <strong>{form.patient.name}</strong> · {form.patient.id}</p>
                  <p className="text-ink"><span className="text-muted">Prescriber:</span> {roleInfo.person ?? currentUser.name}</p>
                </div>
                <p className={`mt-2 font-medium ${record?.allergies?.length ? 'text-danger' : 'text-muted'}`}>
                  {record?.allergiesRecorded
                    ? record?.allergies?.length ? `Allergies: ${record.allergies.join('; ')}` : 'Allergies: none known'
                    : '⚠ Allergies not yet reviewed for this patient'}
                </p>
              </div>

              {!form.dictationId && (
                <form id="prescription-dictation-transcript-form" onSubmit={structureDictation}>
                  <Field
                    label="Dictated transcript"
                    required
                    error={formErrors.transcript}
                    hint="Type or paste what was dictated, e.g. “Start Amoxicillin 500mg capsules, one three times daily for five days.”"
                  >
                    <Textarea
                      value={form.transcript || ''}
                      onChange={setField('transcript')}
                      placeholder="Prescribe amoxicillin 500 milligrams, one capsule three times a day for five days…"
                    />
                  </Field>
                </form>
              )}

              {form.dictationId && (
                <form id="prescription-dictation-approve-form" onSubmit={approveDictatedPrescription} className="space-y-4">
                  {form.medicationsMentioned?.length > 1 && (
                    <div>
                      <p className="mb-1.5 text-xs uppercase tracking-[0.1em] text-muted">Medications heard in the dictation</p>
                      <div className="flex flex-wrap gap-2">
                        {form.medicationsMentioned.map((med, index) => (
                          <button
                            key={`${med.drug}-${index}`}
                            type="button"
                            onClick={() => selectDictatedMedication(index)}
                            className={`rounded border px-2.5 py-1.5 text-sm transition ${
                              form.selectedMedicationIndex === index
                                ? 'border-brand bg-brand-soft text-brand-deep'
                                : 'border-edge text-body hover:border-brand'
                            }`}
                          >
                            {med.drug} {med.strength || ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {(!form.medicationsMentioned || form.medicationsMentioned.length === 0) && (
                    <p className="rounded border border-warning-strong bg-warning-soft p-3 text-sm text-warning-deep">
                      No medication was recognised automatically — fill in the fields below from the transcript.
                    </p>
                  )}

                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Field label="Medication" required error={formErrors.drug}>
                        <Input value={form.drug || ''} onChange={setField('drug')} placeholder="e.g. Amoxicillin" />
                      </Field>
                    </div>
                    <Field label="Strength">
                      <Input value={form.strength || ''} onChange={setField('strength')} placeholder="e.g. 500 mg" />
                    </Field>
                    <Field label="Route">
                      <Input value={form.route || ''} onChange={setField('route')} placeholder="e.g. oral" />
                    </Field>
                    <Field label="Frequency / directions">
                      <Input value={form.frequency || ''} onChange={setField('frequency')} placeholder="e.g. three times daily" />
                    </Field>
                    <Field label="Duration (days)">
                      <Input type="number" min="1" value={form.durationDays || ''} onChange={setField('durationDays')} />
                    </Field>
                  </div>

                  {!record?.allergiesRecorded && (
                    <label className="flex items-center gap-2 text-sm text-body">
                      <input
                        type="checkbox"
                        checked={Boolean(form.allergiesReviewed)}
                        onChange={(event) => setForm((prev) => ({ ...prev, allergiesReviewed: event.target.checked }))}
                        className="h-4 w-4 accent-brand"
                      />
                      I have reviewed this patient&apos;s allergies before prescribing
                    </label>
                  )}
                  {formErrors.allergiesReviewed && (
                    <p className="text-sm text-danger">{formErrors.allergiesReviewed}</p>
                  )}
                </form>
              )}

              {formErrors.submit && (
                <div className="rounded border border-danger-strong bg-danger-soft p-3 text-sm text-danger">
                  {formErrors.submit}
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      <Modal
        open={dialog === 'visitStatus'}
        onClose={closeDialog}
        title={form.label || 'Update visit'}
        footer={(
          <>
            <Button variant="secondary" type="button" onClick={closeDialog}>Keep visit</Button>
            <Button type="submit" form="visit-status-form">{form.label || 'Update visit'}</Button>
          </>
        )}
      >
        <form id="visit-status-form" onSubmit={submitVisitStatusReason} className="space-y-3.5">
          <Field
            label="Reason"
            required
            error={formErrors.reason}
            hint={form.patient ? `${form.patient} · ${form.status === 'cancelled' ? 'Cancellation' : 'No-show'}` : undefined}
          >
            <Textarea value={form.reason || ''} onChange={setField('reason')} placeholder="e.g. Patient called ahead, transport problem, or did not arrive" />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === 'cancelOrder'}
        onClose={closeDialog}
        title={form.decline ? 'Decline this order' : 'Cancel this order'}
        subtitle="Nothing is billed for work that was not done."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Keep it</Button>
          <Button type="submit" form="cancel-order-form">{form.decline ? 'Decline' : 'Cancel order'}</Button>
        </>}
      >
        <form id="cancel-order-form" onSubmit={cancelOrder} className="space-y-3.5">
          <div className="rounded border border-line bg-surface p-3 text-sm">
            <p className="font-medium text-ink">{form.serviceName}</p>
            <p className="mt-1 text-body">{form.patientName} · {form.orderId}</p>
          </div>
          <Field
            label="Reason"
            required
            error={formErrors.reason}
            hint="Kept on the order and in the audit log."
          >
            <Textarea value={form.reason || ''} onChange={setField('reason')} placeholder="e.g. Duplicate of the panel run last week" />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === 'reprice'}
        onClose={closeDialog}
        title={`Re-price ${form.serviceName || 'service'}`}
        subtitle="The current price is kept and closed off, not overwritten."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button
            type="button"
            onClick={() => repriceCatalogueService(form.serviceId, {
              amount: form.amount,
              effectiveFrom: form.effectiveFrom,
            })}
          >
            Apply from this date
          </Button>
        </>}
      >
        <div className="space-y-3.5">
          <div className="rounded border border-line bg-surface p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Current price</span>
              <span className="tabular-nums text-ink">{formatMoney(form.currentPrice ?? 0, billingCurrency)}</span>
            </div>
          </div>

          <Field label={`New price (${billingCurrency})`} required>
            <Input type="number" min="0" step="0.01" value={form.amount || ''} onChange={setField('amount')} />
          </Field>

          <Field
            label="Effective from"
            required
            hint="Invoices dated before this keep the old price for ever. That is the point."
          >
            <Input type="date" value={form.effectiveFrom || ''} onChange={setField('effectiveFrom')} />
          </Field>

          {/* Says plainly what will and will not move, because "update price"
              reads to most people as "change it everywhere". */}
          <p className="text-sm text-body">
            Invoices already raised are not re-priced. Anything billed on or after{' '}
            {form.effectiveFrom || 'the chosen date'} uses{' '}
            {form.amount ? formatMoney(Number(form.amount), billingCurrency) : 'the new price'}.
          </p>
        </div>
      </Modal>

      <Modal
        open={dialog === 'rejection'}
        onClose={closeDialog}
        title="Move a declined claim to the patient"
        subtitle="The scheme has refused it. Someone still owes the money."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Not yet</Button>
          <Button type="submit" form="rejection-form">Move to patient</Button>
        </>}
      >
        <form id="rejection-form" onSubmit={submitPatientResponsibility} className="space-y-3.5">
          <div className="rounded border border-danger-line bg-danger-soft p-3 text-sm">
            <p className="font-medium text-danger-deep">
              {form.claimId} rejected · {form.rejectionCode} {REJECTION_REASONS[form.rejectionCode] ? `· ${REJECTION_REASONS[form.rejectionCode]}` : ''}
            </p>
            <p className="mt-1 text-body">{form.patient} · {form.invoiceId}</p>
          </div>

          {/* Stated as arithmetic rather than described, because this is the
              moment a patient's debt changes and nobody should have to work
              out by how much. */}
          <div className="space-y-2 rounded border border-line bg-surface p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Patient owes now</span>
              <span className="tabular-nums text-ink">{formatMoney(form.alreadyOwed ?? 0, form.invoiceCurrency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Scheme declined</span>
              <span className="tabular-nums text-danger-deep">+ {formatMoney(form.declined ?? 0, form.invoiceCurrency)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-2">
              <span className="font-medium text-ink">Patient will owe</span>
              <span className="font-semibold tabular-nums text-ink">
                {formatMoney(round2(Number(form.alreadyOwed ?? 0) + Number(form.declined ?? 0)), form.invoiceCurrency)}
              </span>
            </div>
          </div>

          <p className="text-sm text-body">
            Do this only once the rejection is settled. If the claim can be corrected and
            resubmitted, do that first — this bills the patient for money the scheme may
            still pay.
          </p>
        </form>
      </Modal>

      <Modal
        open={dialog === 'adjustment'}
        onClose={closeDialog}
        title="Write off or credit a balance"
        subtitle="The debt is discharged, but no money arrived. Both facts stay on the record."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="adjustment-form">Record adjustment</Button>
        </>}
      >
        <form id="adjustment-form" onSubmit={submitAdjustment} className="space-y-3.5">
          <div className="rounded border border-line bg-surface p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{form.patient} · {form.invoiceId}</span>
              <span className="text-base font-medium text-ink">
                {formatMoney(form.outstanding ?? 0, form.invoiceCurrency || billingCurrency)} outstanding
              </span>
            </div>
            {form.days > 0 && (
              <p className="mt-1 text-xs text-danger-deep">{form.days} days past due</p>
            )}
          </div>

          <Field label="Kind" hint={ADJUSTMENT_TYPES.find((a) => a.value === (form.adjustmentType || 'write_off'))?.hint}>
            <Select
              value={form.adjustmentType || 'write_off'}
              onChange={setField('adjustmentType')}
              options={ADJUSTMENT_TYPES.map((a) => a.value)}
            />
          </Field>

          <Field
            label="Amount"
            required
            error={formErrors.amount}
            hint="Part of a balance may be written off; the rest stays collectable."
          >
            <Input type="number" min="0" step="0.01" value={form.amount || ''} onChange={setField('amount')} placeholder="0.00" />
          </Field>

          <Field
            label="Reason"
            required
            error={formErrors.reason}
            hint="Recorded in the audit log at alert severity, against your name."
          >
            <Textarea value={form.reason || ''} onChange={setField('reason')} placeholder="e.g. NH263 rejected R204 and the member has left the scheme" />
          </Field>

          {/* Where the balance lands, before anyone commits to it. */}
          {form.amount && !Number.isNaN(Number(form.amount)) && (
            <div className="rounded border border-edge bg-white p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted">Left collectable</span>
                <span className="font-medium text-ink tabular-nums">
                  {formatMoney(Math.max(0, round2((form.outstanding ?? 0) - Number(form.amount))), form.invoiceCurrency || billingCurrency)}
                </span>
              </div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={dialog === 'statement'}
        onClose={closeDialog}
        title={form.patient ? `Statement · ${form.patient}` : 'Patient statement'}
        subtitle={form.patient
          ? 'Every open invoice on this account. One tender settles them oldest first.'
          : 'Search for a patient to see everything they owe.'}
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Close</Button>
          {access.can.recordPayment && (statementInView?.outstanding ?? 0) > 0 && (
            <Button type="submit" form="statement-form">Settle account</Button>
          )}
        </>}
      >
        <div className="space-y-4">
          <Field label="Patient">
            <PatientPicker patients={practicePatients} value={form.patient || ''} onChange={setValue('patient')} />
          </Field>
        </div>

        {statementInView && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Billed', value: formatMoney(statementInView.billed, statementInView.currency) },
                { label: 'Collected', value: formatMoney(statementInView.collected, statementInView.currency) },
                { label: 'Outstanding', value: formatMoney(statementInView.outstanding, statementInView.currency) },
              ].map((tile) => (
                <div key={tile.label} className="rounded border border-line bg-surface p-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-muted">{tile.label}</p>
                  <p className="mt-1.5 text-sm font-semibold text-ink tabular-nums">{tile.value}</p>
                </div>
              ))}
            </div>

            {/* Written off is reported beside collected, never folded into it.
                An account settled by giving up on it is not a collection. */}
            {statementInView.adjusted > 0 && (
              <p className="text-sm text-body">
                {formatMoney(statementInView.adjusted, statementInView.currency)} of this account has been written off or credited.
              </p>
            )}

            {statementInView.open.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge bg-surface p-4 text-sm text-muted">
                Nothing outstanding. This account is settled in full.
              </p>
            ) : (
              <div className="space-y-2">
                {statementInView.open.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between rounded-lg border border-line bg-white p-3">
                    <div>
                      <p className="text-base font-medium text-ink">{inv.id}</p>
                      <p className="mt-1 text-xs text-body">
                        Issued {inv.date} · due {inv.dueDate}
                        {inv.days > 0 && <span className="ml-2 font-medium text-danger-deep">{inv.days} days overdue</span>}
                      </p>
                    </div>
                    <p className="text-base font-medium text-ink tabular-nums">
                      {formatMoney(inv.outstanding, inv.currency ?? billingCurrency)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {access.can.recordPayment && statementInView.outstanding > 0 && (
              <form id="statement-form" onSubmit={submitStatementPayment} className="grid gap-3.5 border-t border-line pt-4 sm:grid-cols-2">
                <Field label="Amount tendered" required error={formErrors.amount}>
                  <Input type="number" min="0" step="0.01" value={form.amount || ''} onChange={setField('amount')} placeholder="0.00" />
                </Field>
                <Field label="Currency">
                  <Select value={form.currency || billingCurrency} onChange={setField('currency')} options={CURRENCIES} />
                </Field>

                {(form.currency || billingCurrency) !== statementInView.currency && (
                  <div className="sm:col-span-2">
                    <Field
                      label={`Rate for 1 ${form.currency} in ${statementInView.currency}`}
                      required
                      hint="Stored with each row this tender creates, so the receipt never changes when the rate does."
                    >
                      <Input type="number" min="0" step="0.0001" value={form.fxRate || ''} onChange={setField('fxRate')} placeholder="0.0000" />
                    </Field>
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Field label="Method">
                    <Select value={form.method || 'cash'} onChange={setField('method')} options={PAYMENT_METHODS.map((m) => m.value)} />
                  </Field>
                </div>

                {/* Exactly which invoices this tender will clear, and in what
                    order, before the patient hands anything over. */}
                {form.amount && !Number.isNaN(Number(form.amount)) && (() => {
                  const preview = checkStatementPayment(statementInView, {
                    amount: form.amount,
                    currency: form.currency || statementInView.currency,
                    fxRate: form.fxRate,
                  });
                  return (
                    <div className="sm:col-span-2 rounded border border-edge bg-white p-3 text-sm">
                      {preview.ok ? (
                        <>
                          <p className="text-muted">Applies as {formatMoney(preview.applied, statementInView.currency)}, oldest first:</p>
                          <ul className="mt-2 space-y-1">
                            {preview.allocations.map((a) => (
                              <li key={a.invoiceId} className="flex items-center justify-between">
                                <span className="text-ink">{a.invoiceId}</span>
                                <span className="tabular-nums text-ink">
                                  {formatMoney(a.amount, statementInView.currency)}
                                  <span className="ml-2 text-xs text-body">
                                    {a.remaining > 0 ? `${formatMoney(a.remaining, statementInView.currency)} left` : 'settled'}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="text-danger-deep">{preview.message}</p>
                      )}
                    </div>
                  );
                })()}
              </form>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={dialog === 'message'}
        onClose={closeDialog}
        title="Send a patient message"
        subtitle="Queued to the messaging gateway and logged against the patient."
        footer={<>
          <Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button>
          <Button type="submit" form="message-form">Queue message</Button>
        </>}
      >
        <form id="message-form" onSubmit={submitMessage} className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Recipient" required error={formErrors.patient}>
            <PatientPicker patients={practicePatients} value={form.patient || ''} onChange={setValue('patient')} />
          </Field>
          <Field label="Channel">
            <Select value={form.channel || 'SMS'} onChange={setField('channel')} options={['SMS', 'WhatsApp', 'Email']} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Template">
              <Select
                value={form.type || 'Manual message'}
                onChange={(event) => {
                  const preset = {
                    'Appointment reminder': 'Reminder: you have an appointment at the clinic. Reply C to confirm.',
                    'Recall annual review due': 'Your annual review is due. Reply BOOK and we will arrange a time.',
                    'Balance overdue notice': 'Your account has an outstanding balance. Payment options are available at reception.',
                  }[event.target.value];
                  setForm((prev) => ({ ...prev, type: event.target.value, message: preset ?? prev.message }));
                }}
                options={['Manual message', 'Appointment reminder', 'Recall annual review due', 'Balance overdue notice']}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Message" required error={formErrors.message} hint={`${(form.message || '').length}/160 characters`}>
              <Textarea maxLength={160} value={form.message || ''} onChange={setField('message')} placeholder="Type the message…" />
            </Field>
          </div>
        </form>
      </Modal>

      {paletteOpen && (
        <div className="fixed inset-0 z-[55] flex items-start justify-center bg-ink/45 p-4 pt-[12vh] backdrop-blur-[2px]">
          <div className="absolute inset-0" onClick={() => setPaletteOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search everything"
            className="relative w-full max-w-xl overflow-hidden rounded-lg border border-edge bg-white shadow-[0_24px_60px_-12px_rgba(11,21,36,0.4)]"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="text-muted" />
              <input
                autoFocus
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && paletteResults[0]) runPaletteItem(paletteResults[0]);
                }}
                placeholder="Search patients, modules, and actions…"
                className="w-full bg-transparent py-3.5 text-md text-ink outline-none placeholder:text-faint"
              />
              <kbd className="rounded-sm border border-edge bg-surface px-1.5 py-0.5 text-2xs font-medium text-muted">Esc</kbd>
            </div>

            <div className="max-h-[340px] overflow-y-auto p-2">
              {paletteResults.length === 0 ? (
                <p className="px-3 py-8 text-center text-base text-muted">No matches for “{paletteQuery}”.</p>
              ) : paletteResults.map((item, index) => (
                <button
                  key={`${item.kind}-${item.label}`}
                  type="button"
                  onClick={() => runPaletteItem(item)}
                  className="flex w-full items-center justify-between gap-3 rounded px-3 py-2.5 text-left transition hover:bg-surface"
                >
                  <span className="flex items-center gap-2.5">
                    <span className={`rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.08em] ${item.kind === 'Action' ? 'bg-brand-soft text-brand-deep' : item.kind === 'Patient' ? 'bg-teal-soft text-teal-deep' : 'bg-line text-body'}`}>
                      {item.kind}
                    </span>
                    <span className="text-base font-medium text-ink">{item.label}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted">{item.hint}</span>
                    {index === 0 && <kbd className="rounded-sm border border-edge bg-surface px-1.5 py-0.5 text-2xs text-muted">↵</kbd>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Break-glass. Deliberately effortful: a free-text reason, a minimum
          length, and an explicit statement that the access is permanent in the
          log. Friction is the control. */}
      <Modal
        open={Boolean(breakGlassFor)}
        onClose={() => setBreakGlassFor(null)}
        title="You have no care relationship with this patient"
        subtitle={breakGlassFor ? `${breakGlassFor.name} · ${breakGlassFor.id} · under ${breakGlassFor.provider}` : ''}
        footer={<>
          <Button variant="secondary" type="button" onClick={() => setBreakGlassFor(null)}>Cancel</Button>
          <Button
            variant="danger"
            type="button"
            disabled={breakGlassReason.trim().length < 10}
            onClick={confirmBreakGlass}
          >
            Record reason and open chart
          </Button>
        </>}
      >
        <div className="space-y-3.5">
          <div className="flex items-start gap-2.5 rounded border border-warning-line bg-warning-soft p-3">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-base leading-5 text-warning-deep">
              You can open this chart, but the access is recorded against your name permanently and is
              visible to your practice administrator. Only proceed if you have a clinical reason.
            </p>
          </div>
          <Field
            label="Reason for access"
            required
            hint={`${breakGlassReason.trim().length}/10 characters minimum`}
            error={breakGlassReason.length > 0 && breakGlassReason.trim().length < 10 ? 'Give a fuller reason' : undefined}
          >
            <Textarea
              value={breakGlassReason}
              onChange={(e) => setBreakGlassReason(e.target.value)}
              placeholder="e.g. Covering another clinician's list while they are on leave; patient presented acutely."
            />
          </Field>
          <p className="text-xs text-muted">
            Access expires at the end of today. Ask a practice manager for a standing grant if you need longer.
          </p>
        </div>
      </Modal>

      {/* Clearing between presentations, and the honest counterpart to
          persistence: if data now survives a refresh, there must be a way to
          get rid of it deliberately. */}
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demo data"
        subtitle="Restores the seeded cohort and clears everything recorded in this browser."
        footer={<>
          <Button variant="secondary" type="button" onClick={() => setResetOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            type="button"
            onClick={() => { clearAll(); window.location.reload(); }}
          >
            Reset and reload
          </Button>
        </>}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2.5 rounded border border-warning-line bg-warning-soft p-3">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-base leading-5 text-warning-deep">
              Every patient you registered, note you wrote, invoice you raised, and audit entry recorded
              will be discarded. This cannot be undone.
            </p>
          </div>
          <p className="text-sm text-muted">
            Currently stored: {storageSummary().entries} collections, {storageSummary().kb} KB.
            Data lives only in this browser and is never sent anywhere.
          </p>
        </div>
      </Modal>

      <Toast message={toast} />
      </div>

      {/* Outside the workspace element on purpose: the print rule hides
          `.lh-app` wholesale, so a receipt nested inside it would be hidden
          along with everything else. Always in the tree, never visible until a
          receipt is actually being printed. */}
      <ReceiptDocument receipt={receipt} practice={{ ...practice, ...settings.profile }} />
    </>
  );
};

export default LuminaryPMSDemo;
