import React, { useState } from 'react';
import { CalendarDays, Printer, ShieldCheck } from 'lucide-react';
import EncounterNote from '../EncounterNote';
import { NOTE_STATUS } from '../../data/encounters';
import { labResultsByPatient, prescriptionsByPatient, visitStatusTone } from '../../data/clinical';
import { Button, EmptyState } from '../ui';
import { StatusPill } from '../shared/StatusPill';
import PrescriptionPrintDocument from '../shared/PrescriptionPrintDocument';
import { useWorkspace } from '../../lib/workspace';

export default function ClinicalPage() {
  const {
    access, roleInfo, doctorIdentity, patientRecords, practice,
    openNote, setOpenNoteId, saveNote, signNote, addAddendum, completeTriage,
    applyDictationEncounter,
    todaysSchedule, practiceEncounters, practicePatients, practiceQueue,
    openNoteForVisit, visitStatuses, notify, setActiveView, live,
  } = useWorkspace();
  const [prescriptionToPrint, setPrescriptionToPrint] = useState(null);
  const [prescriptionPatient, setPrescriptionPatient] = useState(null);

  const printPrescription = (prescription) => {
    const registryPatient = practicePatients.find((patient) => patient.name === prescription.patient);
    const record = registryPatient ? patientRecords[registryPatient.id] : null;
    setPrescriptionToPrint({
      ...prescription,
      prescriber: prescription.prescriber || prescription.provider || doctorIdentity,
    });
    setPrescriptionPatient(record || registryPatient || { name: prescription.patient });
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

  const renderClinicalWorkspace = () => {
    // A doctor's list is their own patients; everyone else sees the whole clinic.
    const myPatients = access.ownPatientsOnly
      ? todaysSchedule.filter((visit) =>
          visit.provider === doctorIdentity ||
          (visit.status === 'Ready for provider' && (!visit.providerId || visit.provider === 'Unassigned'))
        )
      : todaysSchedule;

    const myNotes = access.ownPatientsOnly
      ? practiceEncounters.filter((note) => note.provider === doctorIdentity)
      : practiceEncounters;

    const unsigned = myNotes.filter((note) => note.status === NOTE_STATUS.DRAFT);
    const clinicalRecords = live
      ? practicePatients.map((patient) => [patient.name, patientRecords[patient.id]])
      : Object.entries(labResultsByPatient).map(([name, labs]) => [name, { labs, prescriptions: prescriptionsByPatient[name] || [] }]);
    const abnormalLabs = clinicalRecords
      .flatMap(([name, record]) => (record?.labs || []).filter((r) => r.tone === 'alert' || r.tone === 'warm').map((r) => ({ ...r, patient: name })))
      .filter((r) => !access.ownPatientsOnly || myPatients.some((v) => v.patient === r.patient));
    const refillsDue = clinicalRecords
      .flatMap(([name, record]) => (record?.prescriptions || []).filter((rx) => Number(rx.refills) === 0 || rx.tone === 'warm').map((rx) => ({ ...rx, patient: name })))
      .filter((rx) => !access.ownPatientsOnly || myPatients.some((v) => v.patient === rx.patient));

    if (!access.can.viewClinicalNotes) {
      return (
        <div className="space-y-6">
          <div className="lh-page-hero">
            <p className="lh-page-kicker">Care</p>
            <h1 className="lh-page-title">Clinical operations</h1>
          </div>
          <EmptyState
            icon={ShieldCheck}
            title="Clinical documentation is outside your access"
            detail={`The ${roleInfo.label} role covers operations and revenue. Consultation notes, vitals, and prescriptions are restricted to clinical staff.`}
          />
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <div className="lh-page-hero flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="lh-page-kicker">
              {access.ownPatientsOnly ? `${doctorIdentity} · clinical workspace` : 'Care'}
            </p>
            <h1 className="lh-page-title">
              {access.ownPatientsOnly ? 'My clinic day' : 'Clinical operations'}
            </h1>
            <p className="lh-page-subtitle">Your clinic list, notes to complete, results to review, and refills to action.</p>
          </div>
          <button type="button" onClick={() => setActiveView('appointments')} className="lh-btn-secondary">
            <CalendarDays size={16} strokeWidth={1.8} />
            Open schedule
          </button>
        </div>

        {/* The clinician's inbox: what is waiting on them specifically. */}
        {/* The clinician's inbox as one overview, not three separate tiles. */}
        <div className="lh-card grid divide-y divide-line/60 md:grid-cols-3 md:divide-x md:divide-y-0">
          {[
            { label: 'Notes to complete', value: unsigned.length, detail: unsigned.length ? 'Drafts awaiting signature' : 'Nothing outstanding', tone: unsigned.length ? 'warm' : 'success' },
            { label: 'Results to review', value: abnormalLabs.length, detail: abnormalLabs.length ? 'Outside normal range' : 'All within range', tone: abnormalLabs.length ? 'alert' : 'success' },
            { label: 'Refills to action', value: refillsDue.length, detail: refillsDue.length ? 'No repeats remaining' : 'None due', tone: refillsDue.length ? 'warm' : 'success' },
          ].map((tile) => (
            <div key={tile.label} className="min-w-0 px-5 py-5">
              <p className="text-small font-medium text-muted">{tile.label}</p>
              <p className={`lh-metric-value mt-2 ${tile.tone === 'alert' ? 'text-danger' : tile.tone === 'warm' ? 'text-warning' : 'text-ink'}`}>
                {tile.value}
              </p>
              <p className="mt-1.5 text-caption text-muted">{tile.detail}</p>
            </div>
          ))}
        </div>

        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
          {/* Today's list — the doctor's actual working queue */}
          <section className="lh-card-pad">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-copy font-semibold text-ink">
                {access.ownPatientsOnly ? 'My patients today' : 'Clinic list today'}
              </h2>
              <span className="text-xs text-muted">{myPatients.length} scheduled</span>
            </div>

            {myPatients.length === 0 ? (
              <EmptyState icon={CalendarDays} title="No patients scheduled" detail="Nothing is booked to you today." />
            ) : (
              <div className="divide-y divide-line/60">
                {myPatients.map((visit) => {
                  const patient = practicePatients.find((p) => p.name === visit.patient);
                  const note = practiceEncounters.find((n) => n.patientId === patient?.id);
                  const status = visitStatuses[visit.id] || 'Booked';
                  const record = patient ? patientRecords[patient.id] : null;
                  return (
                    <div key={`${visit.time}-${visit.patient}`} className="flex flex-wrap items-center gap-3 py-2.5">
                      <span className="w-12 shrink-0 text-small font-medium text-body tnum">{visit.time}</span>
                      <div className="min-w-[160px] flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-copy font-medium text-ink">{visit.patient}</p>
                          {record?.allergies?.length > 0 && (
                            <span title={`Allergies: ${record.allergies.join('; ')}`} className="rounded-sm bg-danger-soft px-1.5 py-0.5 text-2xs font-semibold uppercase text-danger">
                              Allergy
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-body">{visit.type} · {visit.room}</p>
                      </div>
                      <StatusPill label={status} tone={visitStatusTone[status] || 'neutral'} />
                      {note && (
                        <StatusPill
                          label={note.status === NOTE_STATUS.DRAFT ? 'Note draft' : 'Note signed'}
                          tone={note.status === NOTE_STATUS.DRAFT ? 'warm' : 'success'}
                        />
                      )}
                      {patient && access.can.writeNote && (
                        <button
                          type="button"
                          onClick={() => openNoteForVisit(patient, visit)}
                          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-caption font-semibold text-brand-deep transition duration-fast hover:bg-brand/[0.08]"
                        >
                          {note ? 'Open note' : 'Start note'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="space-y-4">
            {/* Notes awaiting signature */}
            <section className="lh-card-pad">
              <h2 className="mb-3 text-copy font-semibold text-ink">Notes to complete</h2>
              {unsigned.length === 0 ? (
                <p className="text-base text-muted">Nothing waiting on you.</p>
              ) : (
                <div className="divide-y divide-line/60">
                  {unsigned.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      onClick={() => setOpenNoteId(note.id)}
                      className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:bg-surface"
                    >
                      <span>
                        <span className="block text-base font-medium text-ink">{note.patientName}</span>
                        <span className="block text-xs text-muted">{note.type} · {note.date} · {note.provider}</span>
                      </span>
                      <StatusPill label="Draft" tone="warm" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Abnormal results */}
            <section className="lh-card-pad">
              <h2 className="mb-3 text-copy font-semibold text-ink">Results to review</h2>
              {abnormalLabs.length === 0 ? (
                <p className="text-base text-muted">No abnormal results outstanding.</p>
              ) : (
                <div className="divide-y divide-line/60">
                  {abnormalLabs.map((lab) => (
                    <div key={`${lab.patient}-${lab.test}`} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <p className="text-base font-medium text-ink">{lab.patient}</p>
                        <p className="text-xs text-muted">{lab.test} · normal {lab.normal}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-base font-semibold ${lab.tone === 'alert' ? 'text-danger' : 'text-warning'}`}>
                          {lab.value} <span className="text-xs font-normal text-muted">{lab.unit}</span>
                        </p>
                        <StatusPill label={lab.status} tone={lab.tone} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Refills */}
            <section className="lh-card-pad">
              <h2 className="mb-3 text-copy font-semibold text-ink">Refills to action</h2>
              {refillsDue.length === 0 ? (
                <p className="text-base text-muted">No repeats due.</p>
              ) : (
                <div className="divide-y divide-line/60">
                  {refillsDue.map((rx) => (
                    <div key={rx.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <p className="text-base font-medium text-ink">{rx.patient}</p>
                        <p className="text-xs text-muted">{rx.drug} {rx.strength} · {rx.refills} refills left</p>
                      </div>
                      {access.can.prescribe ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => printPrescription(rx)}
                            title={`Print prescription ${rx.id}`}
                            aria-label={`Print prescription ${rx.id}`}
                            className="rounded border border-edge p-1.5 text-muted transition hover:border-brand hover:bg-wash hover:text-brand"
                          >
                            <Printer size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => notify(`Repeat authorised for ${rx.patient}, ${rx.drug}`)}
                            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-caption font-semibold text-brand-deep transition duration-fast hover:bg-brand/[0.08]"
                          >
                            Authorise
                          </button>
                        </div>
                      ) : (
                        <span className="text-caption font-medium text-muted">Prescriber only</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>

        {renderClinicalLegacy()}
      </div>
    );
  };

  const renderClinicalLegacy = () => (
    <div className="space-y-6">

      <div className="grid min-w-0 items-start gap-6 2xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="lh-card-pad lh-side-panel">
          <div className="flex items-center justify-between">
            <p className="lh-section-label">Care coordination</p>
            <button type="button" onClick={() => setActiveView('appointments')} className="text-caption font-medium text-brand hover:underline">Open schedule</button>
          </div>

          <div className="mt-4 space-y-3">
            {practiceQueue.map((item) => (
              <div key={item.patient} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3">
                <div>
                  <p className="text-md font-medium text-ink">{item.patient}</p>
                  <p className="mt-1 text-sm text-body">{item.reason}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-body">{item.eta}</span>
                  <StatusPill label={item.status} tone={item.tone} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lh-card-pad lh-side-panel">
          <p className="lh-section-label">Today’s plan</p>
          <div className="mt-4 space-y-4">
            {[{ label: 'Signed notes', value: '96%' }, { label: 'Medication review', value: '89%' }, { label: 'Care plans in sync', value: '94%' }].map((item) => (
              <div key={item.label} className="lh-card-soft p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption font-medium text-body">{item.label}</span>
                  <span className="text-md font-semibold tracking-heading text-ink">{item.value}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { title: 'Medication reconciliation', detail: '4 patients pending pharmacy review', tone: 'warm' },
          { title: 'Discharge documentation', detail: '7 cases ready for sign off', tone: 'neutral' },
          { title: 'Referral tracking', detail: '3 specialists awaiting records', tone: 'success' },
        ].map((item) => (
          <div key={item.title} className="lh-metric">
            <p className="lh-section-label">{item.title}</p>
            <p className="mt-3 text-base leading-6 text-ink-soft">{item.detail}</p>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${item.tone === 'warm' ? 'w-[78%] bg-warning-bright' : item.tone === 'success' ? 'w-[92%] bg-success-bright' : 'w-[66%] bg-brand-bright'}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

    if (openNote) {
      if (!access.can.viewClinicalNotes) {
        return (
          <EmptyState
            icon={ShieldCheck}
            title="Clinical notes are outside your access"
            detail={`The ${roleInfo.label} role does not include reading consultation notes. Ask an administrator if you believe this is wrong.`}
            action={<Button variant="secondary" type="button" onClick={() => setOpenNoteId(null)}>Back</Button>}
          />
        );
      }
      return (
        <EncounterNote
          note={openNote}
          patientRecord={patientRecords[openNote.patientId]}
          onBack={() => setOpenNoteId(null)}
          onSave={saveNote}
          onSign={signNote}
          onAddendum={addAddendum}
          onCompleteTriage={completeTriage}
          onDictationApproved={applyDictationEncounter}
          can={access.can}
          currentUser={roleInfo.person}
        />
      );
    }
    return (
      <>
        <PrescriptionPrintDocument prescription={prescriptionToPrint} patient={prescriptionPatient} practice={practice} />
        {renderClinicalWorkspace()}
      </>
    );
}
