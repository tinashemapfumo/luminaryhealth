import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Download,
  FileText,
  FlaskConical,
  Image,
  Mic,
  Pencil,
  Pill,
  Plus,
  Printer,
  ShieldCheck,
  Stethoscope,
  AlertTriangle,
  CheckCircle2,
  User,
  Upload,
} from 'lucide-react';
import { Field, Input, Select, Textarea, Button, EmptyState, Modal, StickyBar } from './ui';
import PrescriptionPrintDocument from './shared/PrescriptionPrintDocument';
import {
  ageFromDob,
  recordCompleteness,
  BLOOD_TYPES,
  MARITAL_STATUS,
  LANGUAGES,
  CONTACT_METHODS,
  RELATIONSHIPS,
  COVER_PLANS,
  SEX_OPTIONS,
  SMOKING_STATUS,
  ALCOHOL_STATUS,
} from '../data/patientRecords';
import { episodeStatusTone } from '../data/episodes';

const ALL_TABS = ['Summary', 'Demographics', 'Clinical', 'Prescribe', 'Episodes', 'Notes', 'Cover & consent', 'Visits', 'Billing', 'Documents'];

/** Comma-separated text <-> array, so list fields stay editable as plain text. */
const toList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const fromList = (list) => (Array.isArray(list) ? list.join(', ') : '');
const displayText = (value) => String(value ?? '').replace(/Self-pay/g, 'Self pay').replace(/No-show/g, 'No show');

function Row({ label, value, missing }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <span className="shrink-0 text-sm text-muted">{label}</span>
      <span className={`text-right text-base ${missing ? 'italic text-danger' : 'font-medium text-ink'}`}>
        {missing ? 'Not recorded' : value}
      </span>
    </div>
  );
}

function Panel({ title, icon: Icon, action, children }) {
  return (
    <section className="lh-card-pad">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-copy font-semibold text-ink">
          {Icon && <Icon size={14} className="text-brand" />}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function EpisodeLinks({ title, items, empty }) {
  return (
    <div>
      <p className="text-caption font-semibold text-muted">{title}</p>
      {items.length ? (
        <div className="mt-2 space-y-1.5">
          {items.map((item) => (
            <div key={item.id} className="rounded-md border border-line bg-white px-3 py-2 text-sm">
              <p className="font-medium text-ink">{item.label}</p>
              {item.detail && <p className="mt-0.5 text-xs text-body">{item.detail}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      )}
    </div>
  );
}

export default function PatientFile({
  record,
  registry,
  onBack,
  onSave,
  onUploadDocument,
  onDownloadDocument,
  onExportPatient,
  canEdit,
  canPrescribe,
  can = {},
  practice,
  notes = [],
  onOpenNote,
  onStartNote,
  onNewPrescription,
  onDictatePrescription,
  prescriptions = [],
  labs = [],
  carePlans = [],
  episodes = [],
  onStartEpisode,
  onEditEpisode,
  onUpdateEpisode,
  orders = [],
  invoices = [],
  claims = [],
  appointments = [],
  currency,
  formatMoney,
  outstandingOn,
  StatusPill,
  statusTone,
  tab = 'Summary',
  onTabChange,
}) {
  // Notes and Prescribe are hidden entirely from roles without clinical read access.
  const TABS = ALL_TABS.filter((item) => (item !== 'Notes' && item !== 'Prescribe') || can.viewClinicalNotes);
  const setTab = onTabChange;
  const [editing, setEditing] = useState(false);
  const [editScope, setEditScope] = useState('all');
  const [draft, setDraft] = useState(record);
  const [errors, setErrors] = useState({});
  const [documentKind, setDocumentKind] = useState('X-ray');
  const [documentNotes, setDocumentNotes] = useState('');
  const [prescriptionToPrint, setPrescriptionToPrint] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportPurpose, setExportPurpose] = useState('Provider transfer');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportSections, setExportSections] = useState({
    summary: Boolean(can.viewClinicalNotes), clinical: Boolean(can.viewClinicalNotes),
    appointments: true, billing: false, documents: false,
  });
  const fileInput = useRef(null);

  const completeness = useMemo(() => recordCompleteness(record), [record]);
  const age = ageFromDob(record.dob);

  const submitExport = async () => {
    const sections = Object.entries(exportSections).filter(([, enabled]) => enabled).map(([key]) => key);
    setExportError('');
    if (exportPurpose.trim().length < 3) return setExportError('Enter the purpose for this export');
    if (sections.length === 0) return setExportError('Select at least one section');
    setExporting(true);
    try {
      await onExportPatient({
        purpose: exportPurpose.trim(), sections,
        ...(exportFrom ? { dateFrom: exportFrom } : {}), ...(exportTo ? { dateTo: exportTo } : {}),
      });
      setExportOpen(false);
    } catch (error) {
      setExportError(error.message);
    } finally {
      setExporting(false);
    }
  };

  const startEdit = (scope = 'all') => {
    setDraft({
      ...record,
      allergies: fromList(record.allergies),
      conditions: fromList(record.conditions),
      medications: fromList(record.medications),
      familyHistory: fromList(record.familyHistory),
      immunisations: fromList(record.immunisations),
    });
    setErrors({});
    setEditScope(scope);
    setEditing(true);
  };

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = (event) => {
    event.preventDefault();
    const next = {};
    if (editScope === 'all' && !draft.name?.trim()) next.name = 'Full name is required';
    if (editScope === 'all' && !draft.phone?.trim()) next.phone = 'A primary phone number is required';
    if (editScope === 'all' && draft.dob && Number.isNaN(new Date(draft.dob).getTime())) next.dob = 'Enter a valid date';
    if (editScope === 'all' && draft.dob && new Date(draft.dob) > new Date()) next.dob = 'Date of birth cannot be in the future';
    if (editScope === 'all' && draft.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email)) next.email = 'Enter a valid email address';
    if (editScope === 'all' && draft.emergencyPhone && draft.emergencyPhone === draft.phone) {
      next.emergencyPhone = 'Emergency contact must differ from the patient’s own number';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    onSave({
      ...draft,
      name: draft.name?.trim() || record.name,
      allergies: toList(draft.allergies),
      conditions: toList(draft.conditions),
      medications: toList(draft.medications),
      familyHistory: toList(draft.familyHistory),
      immunisations: toList(draft.immunisations),
    });
    setEditing(false);
  };

  const patientInvoices = invoices.filter((invoice) => invoice.patient === record.name);
  const patientClaims = claims.filter((claim) => claim.patient === record.name);
  const patientOrders = orders.filter((order) => order.patientId === record.id || order.patientName === record.name);
  const patientPayments = patientInvoices.flatMap((invoice) => (invoice.payments || []).map((payment) => ({ ...payment, invoice })));
  const patientAdjustments = patientInvoices.flatMap((invoice) => (invoice.adjustments || []).map((adjustment) => ({ ...adjustment, invoice })));
  const patientBilled = patientInvoices.reduce((sum, invoice) => sum + Number(invoice.patientResponsibility || 0), 0);
  const patientCollected = patientPayments.reduce((sum, payment) => sum + Number(payment.amount || 0) * Number(payment.fxRate || 1), 0);
  const patientAdjusted = patientAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
  const patientOutstanding = outstandingOn
    ? patientInvoices.reduce((sum, invoice) => sum + outstandingOn(invoice), 0)
    : registry.balance;
  const patientVisits = appointments.filter((appointment) => appointment.patient === record.name);
  const patientEpisodes = episodes.filter((episode) => episode.patientId === record.id || episode.patientName === record.name);
  const initials = record.name.split(' ').map((part) => part[0]).join('');
  const pickDocument = () => fileInput.current?.click();
  const startEpisode = () => onStartEpisode?.({
    patientId: record.id,
    patientName: record.name,
    title: '',
    reason: '',
    startDate: new Date().toISOString().slice(0, 10),
    primaryDiagnosis: record.conditions?.[0] || '',
    status: 'Active',
    linkedVisitIds: [],
    linkedNoteIds: [],
    linkedOrderIds: [],
    linkedInvoiceIds: [],
    linkedClaimIds: [],
    outcome: '',
  });
  const uploadDocument = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await onUploadDocument?.({ file, kind: documentKind, notes: documentNotes.trim() });
    setDocumentNotes('');
  };
  const printPrescription = (prescription) => {
    setPrescriptionToPrint(prescription);
    window.setTimeout(() => {
      const clear = () => document.body.classList.remove('lh-printing-prescription');
      window.addEventListener('afterprint', clear, { once: true });
      document.body.classList.add('lh-printing-prescription');
      try {
        window.print();
      } finally {
        clear();
      }
    }, 0);
  };

  // Allergy strip tone: red when allergies are recorded, amber when nobody has
  // asked yet, calm only when the answer is genuinely "none known".
  const allergyAlert = !record.allergiesRecorded || record.allergies?.length > 0;
  const allergyTone = !record.allergiesRecorded
    ? 'border-warning-line bg-warning-soft text-warning-deep'
    : record.allergies?.length
      ? 'border-danger-line bg-danger-soft text-danger-deep'
      : 'border-line/70 bg-surface/60 text-body';

  return (
    <>
    <PrescriptionPrintDocument prescription={prescriptionToPrint} patient={record} practice={practice} />
    <div className="space-y-5">
      {/* Chart banner — identity and the facts you must not act without. The
          patient is the subject of the page, so identity leads; the allergy
          strip is its own row because it is a safety control, not metadata. */}
      <div className="lh-surface overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-5 p-5 sm:p-6">
          <div className="flex min-w-0 items-start gap-4">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to registry"
              className="lh-btn-icon -ml-2 mt-2 h-control-sm w-control-sm"
            >
              <ArrowLeft size={17} strokeWidth={1.8} />
            </button>
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-soft text-lg font-semibold text-brand-deep ring-1 ring-inset ring-brand-edge/50">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-heading font-semibold tracking-heading text-ink">{record.name}</h1>
                <StatusPill label={registry.status} tone={statusTone[registry.status]} />
                {record.risk === 'High risk' && (
                  <span className="lh-pill bg-danger-soft font-semibold text-danger-deep ring-danger-line">
                    <AlertTriangle size={12} strokeWidth={2} /> High risk
                  </span>
                )}
              </div>
              <p className="mt-1 text-copy text-body tnum">
                {record.id} · {age} yrs · {record.sex || 'Sex not recorded'} · {record.bloodType || 'Blood type unknown'}
              </p>
              <p className="mt-0.5 text-small text-muted">
                {displayText(record.coverPlan)} · {displayText(record.memberNo)} · Registered {record.registered}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {can.exportPatientRecord && (
                <Button variant="secondary" type="button" onClick={() => setExportOpen(true)}>
                  <Download size={15} strokeWidth={1.8} /> Export file
                </Button>
              )}
              {canEdit && !editing && (
                <Button variant="secondary" type="button" onClick={() => startEdit('all')}>
                  <Pencil size={15} strokeWidth={1.8} /> Edit record
                </Button>
              )}
            </div>
            <div className="w-56">
              <div className="flex items-center justify-between text-caption">
                <span className="text-muted">Record completeness</span>
                <span className={`font-semibold tnum ${completeness.percent === 100 ? 'text-success' : 'text-warning'}`}>
                  {completeness.percent}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
                <div
                  className={`h-full rounded-full transition-[width] duration-slow ${completeness.percent === 100 ? 'bg-success-bright' : 'bg-warning-bright'}`}
                  style={{ width: `${completeness.percent}%` }}
                />
              </div>
              <p className="mt-1 text-caption text-muted">
                {completeness.captured} of {completeness.total} required fields
              </p>
            </div>
          </div>
        </div>

        {/* Allergy banner is deliberately loud — this is a safety control. Red
            when allergies are recorded, amber when nobody has asked yet, calm
            only when the answer is genuinely "none known". */}
        <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-t px-5 py-3 sm:px-6 ${allergyTone}`}>
          <span role={allergyAlert ? 'alert' : undefined} className="inline-flex items-center gap-2 text-small font-semibold">
            {allergyAlert
              ? <AlertTriangle size={16} strokeWidth={2} className="shrink-0" aria-hidden="true" />
              : <CheckCircle2 size={16} strokeWidth={1.8} className="shrink-0 text-success" aria-hidden="true" />}
            {record.allergiesRecorded
              ? record.allergies?.length
                ? `Allergies: ${record.allergies.join('; ')}`
                : 'Allergies: none known'
              : '⚠ Allergies not yet reviewed'}
          </span>
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-small text-muted sm:ml-auto">
            <span>Balance <strong className="font-semibold text-ink tnum">{currency(registry.balance)}</strong></span>
            <span>Next visit <strong className="font-semibold text-ink">{registry.next}</strong></span>
            <span>Provider <strong className="font-semibold text-ink">{registry.provider}</strong></span>
          </span>
        </div>

        {completeness.missing.length > 0 && !editing && (
          <div className="flex flex-wrap items-center gap-2 border-t border-warning-line bg-warning-soft/70 px-5 py-2.5 sm:px-6">
            <AlertTriangle size={15} strokeWidth={1.8} className="text-warning" />
            <span className="text-small text-warning-deep">
              Missing: {completeness.missing.map((field) => field.label).join(', ')}
            </span>
            {canEdit && (
              <button type="button" onClick={() => startEdit('all')} className="text-small font-semibold text-brand hover:underline">
                Complete now
              </button>
            )}
          </div>
        )}
      </div>

      {/* The tab row pins while a long chart scrolls. */}
      <StickyBar className="py-0">
        <div className="lh-tabs border-b-0" role="tablist" aria-label="Patient file sections">
          {TABS.map((item) => (
            <button
              key={item}
              role="tab"
              type="button"
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className="lh-tab"
            >
              {item}
            </button>
          ))}
        </div>
      </StickyBar>

      {editing ? (
        <form onSubmit={save} className="space-y-4">
          {editScope === 'all' && can.editDemographics && <Panel title="Identity" icon={User}>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Full name" required error={errors.name}>
                <Input value={draft.name || ''} onChange={set('name')} />
              </Field>
              <Field label="Preferred name"><Input value={draft.preferredName || ''} onChange={set('preferredName')} /></Field>
              <Field label="Date of birth" required error={errors.dob} hint={draft.dob ? `${ageFromDob(draft.dob)} years old` : undefined}>
                <Input type="date" value={draft.dob || ''} onChange={set('dob')} />
              </Field>
              <Field label="Sex" required><Select value={draft.sex || ''} onChange={set('sex')} options={['', ...SEX_OPTIONS]} /></Field>
              <Field label="National ID" required><Input value={draft.nationalId || ''} onChange={set('nationalId')} placeholder="63-0000000-A-00" /></Field>
              <Field label="Marital status"><Select value={draft.maritalStatus || ''} onChange={set('maritalStatus')} options={['', ...MARITAL_STATUS]} /></Field>
              <Field label="Occupation"><Input value={draft.occupation || ''} onChange={set('occupation')} /></Field>
              <Field label="Preferred language"><Select value={draft.language || ''} onChange={set('language')} options={['', ...LANGUAGES]} /></Field>
            </div>
          </Panel>}

          {editScope === 'all' && can.editDemographics && <Panel title="Contact" icon={User}>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Primary phone" required error={errors.phone}><Input value={draft.phone || ''} onChange={set('phone')} /></Field>
              <Field label="Alternate phone"><Input value={draft.altPhone || ''} onChange={set('altPhone')} /></Field>
              <Field label="Email" error={errors.email}><Input type="email" value={draft.email || ''} onChange={set('email')} /></Field>
              <Field label="Street"><Input value={draft.addressStreet || ''} onChange={set('addressStreet')} /></Field>
              <Field label="Suburb"><Input value={draft.addressSuburb || ''} onChange={set('addressSuburb')} /></Field>
              <Field label="City" required><Input value={draft.addressCity || ''} onChange={set('addressCity')} /></Field>
              <Field label="Country"><Input value={draft.addressCountry || ''} onChange={set('addressCountry')} /></Field>
              <Field label="Preferred contact method"><Select value={draft.preferredContact || ''} onChange={set('preferredContact')} options={['', ...CONTACT_METHODS]} /></Field>
            </div>
          </Panel>}

          {editScope === 'all' && can.editDemographics && <Panel title="Emergency contact" icon={AlertTriangle}>
            <div className="grid gap-3.5 sm:grid-cols-3">
              <Field label="Name" required><Input value={draft.emergencyName || ''} onChange={set('emergencyName')} /></Field>
              <Field label="Relationship"><Select value={draft.emergencyRelationship || ''} onChange={set('emergencyRelationship')} options={['', ...RELATIONSHIPS]} /></Field>
              <Field label="Phone" required error={errors.emergencyPhone}><Input value={draft.emergencyPhone || ''} onChange={set('emergencyPhone')} /></Field>
            </div>
          </Panel>}

          {can.editClinicalHistory && <Panel title="Clinical baseline" icon={Stethoscope}>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Blood type" required><Select value={draft.bloodType || ''} onChange={set('bloodType')} options={['', ...BLOOD_TYPES]} /></Field>
              <Field label="Smoking"><Select value={draft.smoking || ''} onChange={set('smoking')} options={['', ...SMOKING_STATUS]} /></Field>
              <Field label="Alcohol"><Select value={draft.alcohol || ''} onChange={set('alcohol')} options={['', ...ALCOHOL_STATUS]} /></Field>
              <div className="lg:col-span-3">
                <Field label="Allergies" hint="Comma separated. Leave blank only if none are known.">
                  <Input value={draft.allergies || ''} onChange={set('allergies')} placeholder="Penicillin rash, Sulfa drugs anaphylaxis" />
                </Field>
              </div>
              <div className="lg:col-span-3">
                <Field label="Active conditions" hint="Comma separated">
                  <Input value={draft.conditions || ''} onChange={set('conditions')} />
                </Field>
              </div>
              <div className="lg:col-span-3">
                <Field label="Current medications" hint="Comma separated">
                  <Input value={draft.medications || ''} onChange={set('medications')} />
                </Field>
              </div>
              <div className="lg:col-span-3">
                <Field label="Family history" hint="Comma separated">
                  <Input value={draft.familyHistory || ''} onChange={set('familyHistory')} />
                </Field>
              </div>
              <div className="lg:col-span-3">
                <Field label="Immunisations" hint="Comma separated">
                  <Input value={draft.immunisations || ''} onChange={set('immunisations')} />
                </Field>
              </div>
              <div className="lg:col-span-3">
                <Field label="Clinical summary">
                  <Textarea value={draft.notes || ''} onChange={set('notes')} />
                </Field>
              </div>
              <label className="flex items-center gap-2.5 text-base text-ink lg:col-span-3">
                <input type="checkbox" checked={!!draft.allergiesRecorded} onChange={set('allergiesRecorded')} className="h-4 w-4 accent-brand" />
                Allergy history has been reviewed with the patient
              </label>
            </div>
          </Panel>}

          {editScope === 'all' && can.editCover && <Panel title="Cover and consent" icon={ShieldCheck}>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Cover plan" required><Select value={draft.coverPlan || ''} onChange={set('coverPlan')} options={['', ...COVER_PLANS]} /></Field>
              <Field label="Member number"><Input value={draft.memberNo || ''} onChange={set('memberNo')} /></Field>
              <Field label="Principal member"><Input value={draft.principalMember || ''} onChange={set('principalMember')} /></Field>
              <Field label="Dependant code"><Input value={draft.dependantCode || ''} onChange={set('dependantCode')} /></Field>
              <Field label="Cover starts"><Input type="date" value={draft.coverEffectiveFrom || ''} onChange={set('coverEffectiveFrom')} /></Field>
              <Field label="Cover valid until"><Input type="date" value={draft.coverValidUntil || ''} onChange={set('coverValidUntil')} /></Field>
              <Field label="Cover status"><Input value={draft.coverStatus || ''} onChange={set('coverStatus')} /></Field>
              <div className="space-y-2 lg:col-span-3">
                {[
                  ['consentTreatment', 'Consent to treatment (required before clinical care)'],
                  ['consentComms', 'Consent to SMS, WhatsApp, and email reminders'],
                  ['consentDataSharing', 'Consent to share records with referred providers'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2.5 text-base text-ink">
                    <input type="checkbox" checked={!!draft[key]} onChange={set(key)} className="h-4 w-4 accent-brand" />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </Panel>}

          <div className="sticky bottom-0 flex items-center justify-end gap-2 rounded-lg border border-line bg-white/95 p-3 backdrop-blur">
            <Button variant="secondary" type="button" onClick={() => setEditing(false)}>Discard changes</Button>
            <Button type="submit">{editScope === 'clinical' ? 'Save clinical information' : 'Save record'}</Button>
          </div>
        </form>
      ) : (
        <>
          {tab === 'Summary' && (
            <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
              <div className="lh-side-panel space-y-4">
                <Panel title="Clinical summary" icon={Stethoscope}>
                  <p className="text-base leading-6 text-ink-soft">{record.notes || 'No summary recorded.'}</p>
                </Panel>
                <Panel title="Care timeline" icon={CalendarDays}>
                  <div className="space-y-2.5">
                    {record.timeline.map((item) => (
                      <div key={item.label + item.date} className="flex gap-3">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.tone === 'success' ? 'bg-success-bright' : item.tone === 'alert' ? 'bg-danger-bright' : item.tone === 'warm' ? 'bg-warning-bright' : 'bg-edge-strong'}`} />
                        <div>
                          <p className="text-base font-medium text-ink">{item.label}</p>
                          <p className="text-sm text-body">{item.date} · {item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title="Care plans" icon={FileText}>
                  {carePlans.length === 0 ? (
                    <p className="text-base text-muted">No active care plans.</p>
                  ) : carePlans.map((plan) => (
                    <div key={plan.id} className="mb-2.5 last:mb-0">
                      <div className="flex items-center justify-between">
                        <p className="text-base font-medium text-ink">{plan.name}</p>
                        <span className="text-sm font-medium text-brand">{plan.progress}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">Since {plan.startDate} · next review {plan.nextReview}</p>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-brand" style={{ width: plan.progress }} />
                      </div>
                    </div>
                  ))}
                </Panel>
              </div>

              <div className="space-y-4">
                <Panel title="At a glance" icon={User}>
                  <Row label="Age" value={`${age} years`} />
                  <Row label="Sex" value={record.sex} missing={!record.sex} />
                  <Row label="Blood type" value={record.bloodType} missing={!record.bloodType} />
                  <Row label="Risk" value={record.risk} />
                  <Row label="Preferred contact" value={record.preferredContact} missing={!record.preferredContact} />
                  <Row label="Language" value={record.language} missing={!record.language} />
                </Panel>
                <Panel title="Emergency contact" icon={AlertTriangle}>
                  <Row label="Name" value={record.emergencyName} missing={!record.emergencyName} />
                  <Row label="Relationship" value={record.emergencyRelationship} missing={!record.emergencyRelationship} />
                  <Row label="Phone" value={record.emergencyPhone} missing={!record.emergencyPhone} />
                </Panel>
                <Panel title="Active medications" icon={Pill}>
                  {record.medications?.length ? (
                    <ul className="space-y-1.5 text-base text-ink-soft">
                      {record.medications.map((med) => <li key={med}>• {med}</li>)}
                    </ul>
                  ) : <p className="text-base text-muted">None recorded.</p>}
                </Panel>
              </div>
            </div>
          )}

          {tab === 'Demographics' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Identity" icon={User}>
                <Row label="Full name" value={record.name} />
                <Row label="Preferred name" value={record.preferredName} missing={!record.preferredName} />
                <Row label="Date of birth" value={record.dob} missing={!record.dob} />
                <Row label="Age" value={`${age} years`} />
                <Row label="Sex" value={record.sex} missing={!record.sex} />
                <Row label="National ID" value={record.nationalId} missing={!record.nationalId} />
                <Row label="Marital status" value={record.maritalStatus} missing={!record.maritalStatus} />
                <Row label="Occupation" value={record.occupation} missing={!record.occupation} />
                <Row label="Language" value={record.language} missing={!record.language} />
              </Panel>
              <Panel title="Contact" icon={User}>
                <Row label="Primary phone" value={record.phone} missing={!record.phone} />
                <Row label="Alternate phone" value={record.altPhone} missing={!record.altPhone} />
                <Row label="Email" value={record.email} missing={!record.email} />
                <Row label="Street" value={record.addressStreet} missing={!record.addressStreet} />
                <Row label="Suburb" value={record.addressSuburb} missing={!record.addressSuburb} />
                <Row label="City" value={record.addressCity} missing={!record.addressCity} />
                <Row label="Country" value={record.addressCountry} />
                <Row label="Preferred method" value={record.preferredContact} missing={!record.preferredContact} />
              </Panel>
              <Panel title="Emergency & social" icon={AlertTriangle}>
                <Row label="Emergency contact" value={record.emergencyName} missing={!record.emergencyName} />
                <Row label="Relationship" value={record.emergencyRelationship} missing={!record.emergencyRelationship} />
                <Row label="Emergency phone" value={record.emergencyPhone} missing={!record.emergencyPhone} />
                <Row label="Smoking" value={record.smoking} />
                <Row label="Alcohol" value={record.alcohol} />
                <Row label="Exercise" value={record.exercise} missing={!record.exercise} />
                <Row label="Registered" value={record.registered} />
              </Panel>
            </div>
          )}

          {tab === 'Clinical' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel
                title="Conditions & history"
                icon={Stethoscope}
                action={can.editClinicalHistory ? (
                  <Button variant="secondary" type="button" onClick={() => startEdit('clinical')}>
                    <Plus size={13} /> Add clinical information
                  </Button>
                ) : null}
              >
                <p className="mb-1.5 text-caption font-medium text-muted">Active conditions</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {record.conditions?.length ? record.conditions.map((c) => (
                    <span key={c} className="rounded bg-brand-soft px-2 py-1 text-sm text-brand-deep">{c}</span>
                  )) : <span className="text-base text-muted">None recorded</span>}
                </div>
                <p className="mb-1.5 text-caption font-medium text-muted">Allergies</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {record.allergies?.length ? record.allergies.map((a) => (
                    <span key={a} className="rounded bg-danger-soft px-2 py-1 text-sm font-medium text-danger">{a}</span>
                  )) : <span className="text-base text-muted">{record.allergiesRecorded ? 'None known' : 'Not yet reviewed'}</span>}
                </div>
                <p className="mb-1.5 text-caption font-medium text-muted">Family history</p>
                <ul className="mb-3 space-y-1 text-base text-ink-soft">
                  {record.familyHistory?.length ? record.familyHistory.map((f) => <li key={f}>• {f}</li>) : <li className="text-muted">None recorded</li>}
                </ul>
                <p className="mb-1.5 text-caption font-medium text-muted">Immunisations</p>
                <ul className="space-y-1 text-base text-ink-soft">
                  {record.immunisations?.length ? record.immunisations.map((i) => <li key={i}>• {i}</li>) : <li className="text-muted">None recorded</li>}
                </ul>
              </Panel>

              <Panel title="Recent results" icon={FlaskConical}>
                {labs.length === 0 ? (
                  <p className="text-base text-muted">No results on file.</p>
                ) : labs.map((lab) => (
                  <div key={lab.test} className="flex items-start justify-between gap-3 border-b border-line py-2 last:border-0">
                    <div>
                      <p className="text-base font-medium text-ink">{lab.test}</p>
                      <p className="text-xs text-muted">Normal {lab.normal} · {lab.date}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-base font-semibold ${lab.tone === 'alert' ? 'text-danger' : lab.tone === 'warm' ? 'text-warning' : 'text-ink'}`}>
                        {lab.value} <span className="text-xs font-normal text-muted">{lab.unit}</span>
                      </p>
                      <StatusPill label={lab.status} tone={lab.tone} />
                    </div>
                  </div>
                ))}
              </Panel>
            </div>
          )}

          {tab === 'Prescribe' && (
            <Panel
              title="Prescriptions"
              icon={Pill}
              action={canPrescribe
                ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onDictatePrescription?.()}
                      className="flex items-center gap-1 rounded border border-edge px-2 py-1 text-xs font-medium text-body transition hover:border-brand hover:text-brand"
                    >
                      <Mic size={12} /> Dictate prescription
                    </button>
                    <button
                      type="button"
                      onClick={() => onNewPrescription?.()}
                      className="flex items-center gap-1 rounded border border-brand px-2 py-1 text-xs font-medium text-brand transition hover:bg-brand-soft"
                    >
                      <Plus size={12} /> New prescription
                    </button>
                  </div>
                )
                : <span className="text-caption font-medium text-muted">Read only</span>}
            >
              {prescriptions.length === 0 ? (
                <p className="text-base text-muted">No prescriptions on file.</p>
              ) : prescriptions.map((rx) => (
                <div key={rx.id} className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-0">
                  <div>
                    <p className="text-base font-medium text-ink">{rx.drug} {rx.strength}</p>
                    <p className="text-xs text-muted">{rx.frequency} · {rx.refills} refills · {rx.pharmacy}</p>
                    {rx.prescriber && <p className="mt-0.5 text-xs text-muted">Prescribed by {rx.prescriber}{rx.issuedAt ? ` · ${rx.issuedAt}` : ''}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => printPrescription(rx)}
                      className="rounded border border-edge p-1.5 text-muted transition hover:border-brand hover:text-brand"
                      title="Print prescription"
                      aria-label={`Print prescription ${rx.id}`}
                    >
                      <Printer size={14} />
                    </button>
                    <StatusPill label={rx.status} tone={rx.tone} />
                  </div>
                </div>
              ))}
            </Panel>
          )}

          {tab === 'Episodes' && (
            <Panel
              title="Episodes of care"
              icon={ClipboardList}
              action={canEdit && (
                <Button variant="secondary" type="button" onClick={startEpisode}>
                  <Plus size={13} /> Start new episode
                </Button>
              )}
            >
              {patientEpisodes.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No episodes"
                  detail="Start an episode to group visits, notes, orders, invoices, and claims around one clinical problem."
                  action={canEdit && <Button type="button" onClick={startEpisode}>Start new episode</Button>}
                />
              ) : (
                <div className="space-y-4">
                  {patientEpisodes.map((episode) => {
                    const linkedVisits = patientVisits.filter((visit) => episode.linkedVisitIds?.includes(visit.id));
                    const linkedNotes = notes.filter((note) => episode.linkedNoteIds?.includes(note.id));
                    const linkedOrders = patientOrders.filter((order) => episode.linkedOrderIds?.includes(order.id));
                    const linkedInvoices = patientInvoices.filter((invoice) => episode.linkedInvoiceIds?.includes(invoice.id));
                    const linkedClaims = patientClaims.filter((claim) => episode.linkedClaimIds?.includes(claim.id));

                    return (
                      <article key={episode.id} className="rounded-lg border border-line bg-surface p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-lg font-semibold tracking-heading text-ink">{episode.title}</h3>
                              <StatusPill label={episode.status} tone={episodeStatusTone[episode.status] || 'neutral'} />
                            </div>
                            <p className="mt-1 text-sm text-body">{episode.reason || 'No reason recorded.'}</p>
                            <p className="mt-2 text-xs text-muted">Started {episode.startDate || 'Not recorded'} | {episode.primaryDiagnosis || 'No diagnosis recorded'}</p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {canEdit && (
                              <Button variant="secondary" type="button" onClick={() => onEditEpisode?.(episode)}>
                                <Pencil size={13} /> Edit
                              </Button>
                            )}
                            {canEdit && episode.status !== 'Closed' && (
                              <button
                                type="button"
                                onClick={() => onUpdateEpisode?.(episode.id, { status: 'Closed' })}
                                className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-body transition hover:border-brand-edge hover:text-brand"
                              >
                                Close
                              </button>
                            )}
                          </div>
                        </div>

                        {episode.outcome && (
                          <div className="mt-3 rounded-md border border-line bg-white p-3">
                            <p className="text-caption font-semibold text-muted">Outcome</p>
                            <p className="mt-1 text-sm text-ink-soft">{episode.outcome}</p>
                          </div>
                        )}

                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                          <EpisodeLinks
                            title="Visits"
                            items={linkedVisits.map((visit) => ({
                              id: visit.id,
                              label: `${visit.time} | ${visit.type}`,
                              detail: `${visit.provider} | ${visit.room || visit.mode || 'No room'}`,
                            }))}
                            empty="No visits linked yet."
                          />
                          <EpisodeLinks
                            title="Notes"
                            items={linkedNotes.map((note) => ({
                              id: note.id,
                              label: `${note.date} | ${note.type}`,
                              detail: `${note.status} | ${note.provider}`,
                            }))}
                            empty="No notes linked yet."
                          />
                          <EpisodeLinks
                            title="Orders"
                            items={linkedOrders.map((order) => ({
                              id: order.id,
                              label: `${order.id} | ${order.serviceName}`,
                              detail: `${order.status} | ${order.department} | ${order.priority}`,
                            }))}
                            empty="No orders linked yet."
                          />
                          <EpisodeLinks
                            title="Invoices"
                            items={linkedInvoices.map((invoice) => ({
                              id: invoice.id,
                              label: `${invoice.id} | ${formatMoney ? formatMoney(invoice.amount, invoice.currency) : currency(invoice.amount)}`,
                              detail: `${invoice.claimStatus || 'Draft claim'} | patient balance ${formatMoney ? formatMoney(outstandingOn?.(invoice) ?? 0, invoice.currency) : currency(outstandingOn?.(invoice) ?? 0)}`,
                            }))}
                            empty="No invoices linked yet."
                          />
                          <EpisodeLinks
                            title="Claims"
                            items={linkedClaims.map((claim) => ({
                              id: claim.id,
                              label: `${claim.id} | ${claim.status}`,
                              detail: claim.plan || claim.payerName || claim.channel || 'No payer',
                            }))}
                            empty="No claims linked yet."
                          />
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {tab === 'Notes' && (
            <Panel
              title="Encounter notes"
              icon={Stethoscope}
              action={can.writeNote && (
                <Button variant="secondary" type="button" onClick={onStartNote}>
                  <Plus size={13} /> New note
                </Button>
              )}
            >
              {notes.length === 0 ? (
                <EmptyState
                  icon={Stethoscope}
                  title="No encounter notes"
                  detail="Nothing has been documented for this patient yet."
                  action={can.writeNote && <Button type="button" onClick={onStartNote}>Start a note</Button>}
                />
              ) : (
                <div className="divide-y divide-line">
                  {notes.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      onClick={() => onOpenNote(note.id)}
                      className="flex w-full items-start justify-between gap-3 py-3 text-left transition hover:bg-surface"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-medium text-ink">{note.type}</span>
                          <StatusPill
                            label={note.status}
                            tone={note.status === 'Draft' ? 'warm' : note.status === 'Amended' ? 'accent' : 'success'}
                          />
                        </div>
                        <p className="mt-0.5 text-xs text-muted">
                          {[
                            `${note.date}${note.appointmentTime !== 'Unscheduled' ? ` at ${note.appointmentTime}` : ''}`,
                            note.createdBy ? `created by ${note.createdBy}` : note.provider,
                            note.contributors?.length
                              ? `contributors: ${[...new Set(note.contributors.map((item) => item.name).filter(Boolean))].join(', ')}`
                              : '',
                            note.signedBy ? `signed by ${note.signedBy}` : '',
                            note.signedAt ? `signed ${note.signedAt}` : '',
                          ].filter(Boolean).join(' | ')}
                        </p>
                        {note.triageCompletedAt && (
                          <p className="mt-1 text-xs text-success">
                            Triage complete{note.triageCompletedBy ? ` by ${note.triageCompletedBy}` : ''} | {note.triageCompletedAt}
                          </p>
                        )}
                        {note.assessment && (
                          <p className="mt-1.5 line-clamp-2 max-w-xl text-sm leading-5 text-body">{note.assessment}</p>
                        )}
                        {note.diagnoses?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {note.diagnoses.map((dx) => (
                              <span key={dx.code} className="rounded-sm bg-brand-soft px-1.5 py-0.5 text-2xs font-medium text-brand-deep">
                                {dx.code}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 text-xs font-medium text-brand">Open</span>
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === 'Cover & consent' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Medical aid cover" icon={ShieldCheck}>
                <Row label="Scheme" value="NH263" />
                <Row label="Plan" value={displayText(record.coverPlan)} missing={!record.coverPlan} />
                <Row label="Member number" value={displayText(record.memberNo)} missing={!record.memberNo} />
                <Row label="Principal member" value={record.principalMember} missing={!record.principalMember} />
                <Row label="Dependant code" value={record.dependantCode} missing={!record.dependantCode} />
                <Row label="Effective from" value={record.coverEffectiveFrom} missing={!record.coverEffectiveFrom} />
                <Row label="Valid until" value={record.coverValidUntil} missing={!record.coverValidUntil} />
                <div className="lh-card-soft mt-3 p-3">
                  <p className="text-caption font-medium text-muted">Cover status</p>
                  <p className={`mt-1 text-base font-medium ${record.coverStatus?.startsWith('Suspended') ? 'text-danger' : 'text-success'}`}>
                    {record.coverStatus}
                  </p>
                </div>
              </Panel>
              <Panel title="Consent" icon={FileText}>
                {[
                  ['consentTreatment', 'Consent to treatment', 'Required before any clinical care is delivered'],
                  ['consentComms', 'Consent to reminders', 'SMS, WhatsApp, and email outreach'],
                  ['consentDataSharing', 'Consent to record sharing', 'Sharing with referred providers'],
                ].map(([key, label, detail]) => (
                  <div key={key} className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-0">
                    <div>
                      <p className="text-base font-medium text-ink">{label}</p>
                      <p className="text-xs text-muted">{detail}</p>
                    </div>
                    <StatusPill label={record[key] ? 'Given' : 'Outstanding'} tone={record[key] ? 'success' : 'alert'} />
                  </div>
                ))}
              </Panel>
            </div>
          )}

          {tab === 'Visits' && (
            <Panel title="Scheduled visits" icon={CalendarDays}>
              {patientVisits.length === 0 ? (
                <EmptyState icon={CalendarDays} title="No visits scheduled" detail="This patient has no upcoming appointments on the books." />
              ) : patientVisits.map((visit) => (
                <div key={visit.time} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-0">
                  <div>
                    <p className="text-base font-medium text-ink">{visit.time} · {visit.type}</p>
                    <p className="text-xs text-muted">{visit.provider} · {visit.room} · {visit.mode}</p>
                  </div>
                </div>
              ))}
            </Panel>
          )}

          {tab === 'Billing' && (
            <Panel title="Patient account" icon={CreditCard}>
              {patientInvoices.length === 0 ? (
                <EmptyState icon={CreditCard} title="No invoices" detail="Nothing has been billed to this patient yet." />
              ) : (
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-4">
                    {[
                      ['Billed to patient', patientBilled, 'neutral'],
                      ['Collected', patientCollected, 'success'],
                      ['Credits/write-offs', patientAdjusted, patientAdjusted > 0 ? 'alert' : 'neutral'],
                      ['Closing balance', patientOutstanding, patientOutstanding > 0 ? 'warm' : 'success'],
                    ].map(([label, value, tone]) => (
                      <div key={label} className={`rounded-lg border p-3 ${tone === 'success' ? 'border-success/20 bg-success-soft' : tone === 'warm' ? 'border-warning/20 bg-warning-wash' : tone === 'alert' ? 'border-danger/20 bg-danger-soft' : 'border-line bg-white'}`}>
                        <p className="text-caption font-semibold text-muted">{label}</p>
                        <p className="mt-2 text-base font-semibold text-ink tabular-nums">
                          {formatMoney ? formatMoney(value, patientInvoices[0]?.currency) : currency(value)}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div>
                    <p className="mb-2 text-caption font-semibold text-muted">Invoices</p>
                    <div className="overflow-x-auto rounded-lg border border-line bg-white">
                      <table className="min-w-full text-left text-md">
                        <thead className="bg-surface text-caption font-medium text-muted">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Invoice</th>
                            <th className="px-3 py-2 font-semibold">Issued</th>
                            <th className="px-3 py-2 font-semibold">Claim</th>
                            <th className="px-3 py-2 text-right font-semibold">Amount</th>
                            <th className="px-3 py-2 text-right font-semibold">Patient balance</th>
                            <th className="px-3 py-2 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {patientInvoices.map((invoice) => (
                            <tr key={invoice.id} className="border-t border-line">
                              <td className="px-3 py-2 font-medium text-ink">{invoice.id}</td>
                              <td className="px-3 py-2 text-body">{invoice.date}</td>
                              <td className="px-3 py-2 text-body">{invoice.claimStatus}</td>
                              <td className="px-3 py-2 text-right text-ink">{currency(invoice.amount)}</td>
                              <td className="px-3 py-2 text-right text-ink">{currency(outstandingOn ? outstandingOn(invoice) : invoice.patientResponsibility)}</td>
                              <td className="px-3 py-2"><StatusPill label={invoice.status} tone={invoice.tone} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <p className="mb-2 text-caption font-semibold text-muted">Payments</p>
                      {patientPayments.length ? (
                        <div className="space-y-2">
                          {patientPayments.map((payment) => (
                            <div key={`${payment.invoice.id}-${payment.id}`} className="rounded-lg border border-line bg-white p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="font-medium text-ink">{payment.invoice.id}</p>
                                  <p className="mt-1 text-xs text-body">{payment.method} · {String(payment.receivedAt).slice(0, 10)}</p>
                                </div>
                                <p className="font-semibold text-ink tabular-nums">{formatMoney ? formatMoney(payment.amount, payment.currency) : currency(payment.amount)}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">No payments recorded for this patient.</p>}
                    </div>

                    <div>
                      <p className="mb-2 text-caption font-semibold text-muted">Claims</p>
                      {patientClaims.length ? (
                        <div className="space-y-2">
                          {patientClaims.map((claim) => (
                            <div key={claim.id} className="rounded-lg border border-line bg-white p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="font-medium text-ink">{claim.id}</p>
                                  <p className="mt-1 text-xs text-body">{claim.plan || claim.payerName} · {claim.submissionChannel || claim.channel || 'Switch'}</p>
                                </div>
                                <StatusPill label={claim.status} tone={claim.status === 'Rejected' ? 'alert' : claim.status === 'Approved' || claim.status === 'Adjudicated' ? 'success' : 'warm'} />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">No claims recorded for this patient.</p>}
                    </div>
                  </div>
                </div>
              )}
            </Panel>
          )}

          {tab === 'Documents' && (
            <Panel
              title="Documents"
              icon={FileText}
              action={can.writeNote && (
                <Button variant="secondary" type="button" onClick={pickDocument}>
                  <Upload size={13} /> Upload
                </Button>
              )}
            >
              {can.writeNote && (
                <div className="mb-4 grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-[180px_1fr_auto]">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/webp,application/dicom,.dcm"
                    className="sr-only"
                    onChange={uploadDocument}
                  />
                  <Field label="Kind">
                    <Select
                      value={documentKind}
                      onChange={(event) => setDocumentKind(event.target.value)}
                      options={['X-ray', 'Scan', 'Lab result', 'Referral', 'Consent', 'Cover card', 'Other']}
                    />
                  </Field>
                  <Field label="Notes">
                    <Input
                      value={documentNotes}
                      onChange={(event) => setDocumentNotes(event.target.value)}
                      placeholder="e.g. Left wrist AP/lateral"
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button type="button" onClick={pickDocument}>
                      <Upload size={13} /> Choose file
                    </Button>
                  </div>
                </div>
              )}
              {record.documents?.length === 0 ? (
                <EmptyState icon={FileText} title="No documents on file" detail="Consent forms, cover cards, and diagnostics will appear here once uploaded." />
              ) : (
                <div className="divide-y divide-line">
                  {record.documents.map((doc) => (
                    <div key={doc.id || doc.name} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        {doc.contentType?.startsWith('image/') ? (
                          <Image size={15} className="text-muted" />
                        ) : (
                          <FileText size={15} className="text-muted" />
                        )}
                        <div>
                          <p className="text-base font-medium text-ink">{doc.name}</p>
                          {doc.notes && <p className="mt-0.5 text-xs text-body">{doc.notes}</p>}
                          <p className="text-xs text-muted">{doc.kind} · {doc.added} · {doc.size}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onDownloadDocument?.(doc)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-xs font-medium text-brand transition hover:border-brand hover:bg-wash"
                      >
                        <Download size={12} /> Download
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}
        </>
      )}
      </div>
      <Modal
        open={exportOpen}
        onClose={() => !exporting && setExportOpen(false)}
        title="Export Patient File"
        subtitle={record.name}
        footer={(
          <>
            <Button variant="secondary" type="button" onClick={() => setExportOpen(false)} disabled={exporting}>Cancel</Button>
            <Button type="button" onClick={submitExport} disabled={exporting}>
              <Download size={14} /> {exporting ? 'Preparing...' : 'Export'}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Field label="Purpose" required error={exportError}>
            <Input value={exportPurpose} onChange={(event) => setExportPurpose(event.target.value)} maxLength={240} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From"><Input type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} /></Field>
            <Field label="To"><Input type="date" value={exportTo} onChange={(event) => setExportTo(event.target.value)} /></Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-ink">Sections</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {[
                ['summary','Patient summary',can.viewClinicalNotes], ['clinical','Clinical record',can.viewClinicalNotes],
                ['appointments','Appointments',true], ['billing','Billing',can.readClaims],
                ['documents','Original documents',can.viewClinicalNotes],
              ].filter(([, , allowed]) => allowed).map(([key,label]) => (
                <label key={key} className="flex items-center gap-2 rounded border border-line px-3 py-2 text-sm text-ink">
                  <input type="checkbox" checked={Boolean(exportSections[key])}
                    onChange={(event) => setExportSections((current) => ({ ...current, [key]: event.target.checked }))} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>
    </>
  );
}
