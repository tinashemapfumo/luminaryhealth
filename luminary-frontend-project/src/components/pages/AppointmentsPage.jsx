import React from 'react';
import { Plus } from 'lucide-react';
import ScheduleCalendar from '../ScheduleCalendar';

import { visitStatusFlow, visitStatusTone } from '../../data/clinical';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { useWorkspace } from '../../lib/workspace';

export default function AppointmentsPage() {
  const { access, configuredProviders, configuredRooms, practiceSchedule, todaysSchedule, selectedAppointment, setSelectedAppointment, moveAppointment, openDialog, exportCsv, visitStatuses, advanceVisitStatus, markNoShow, cancelVisit, doctorIdentity, billVisit, practiceInvoices } = useWorkspace();
  const defaultProvider = configuredProviders[0] || 'Unassigned';
  const defaultRoom = configuredRooms[0] || 'Unassigned';

  if (!selectedAppointment) {
    return (
      <div className="space-y-6">
        <div className="lh-page-hero">
          <h1 className="lh-page-title">Appointments</h1>
          <p className="lh-page-subtitle">Manage your daily schedule and bookings.</p>
        </div>
        <EmptyState
          title="Nothing booked"
          detail="This practice has no appointments in the schedule. Book a visit and the calendar and day list will fill in."
          action={access.can.scheduleVisit && (
            <button type="button" onClick={() => openDialog('appointment')} className="lh-primary-button">
              <Plus size={14} />
              Book a visit
            </button>
          )}
        />
      </div>
    );
  }

  // The invoice raised from this visit, if there is one. Matched on the visit
  // id rather than patient-and-day, so a patient seen twice is billed twice.
  const billed = practiceInvoices.find((invoice) => invoice.fromVisit === selectedAppointment.id);

  return (
    <div className="space-y-6">
      <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="lh-page-title">Appointments</h1>
          <p className="lh-page-subtitle">Manage your daily schedule and bookings.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => exportCsv('day-sheet.csv', [
              { label: 'Time', get: (r) => r.time },
              { label: 'Duration (min)', get: (r) => r.duration || 30 },
              { label: 'Patient', get: (r) => r.patient },
              { label: 'Type', get: (r) => r.type },
              { label: 'Provider', get: (r) => r.provider },
              { label: 'Room', get: (r) => r.room },
              { label: 'Status', get: (r) => visitStatuses[r.id] || 'Booked' },
            ], todaysSchedule)}
            className="lh-secondary-button"
          >
            Export day sheet
          </button>
          {access.can.scheduleVisit && (
            <button type="button" onClick={() => openDialog('appointment', { provider: defaultProvider, room: defaultRoom, mode: 'In-person', duration: '30', day: 0 })} className="lh-primary-button">
              <Plus size={14} />
              Schedule visit
            </button>
          )}
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <ScheduleCalendar
          appointments={practiceSchedule}
          providers={configuredProviders}
          rooms={configuredRooms}
          visitStatuses={visitStatuses}
          selectedId={selectedAppointment.id}
          onSelect={setSelectedAppointment}
          onMove={moveAppointment}
          onBookSlot={(slot) =>
            openDialog('appointment', {
              time: slot.time,
              provider: slot.provider || defaultProvider,
              room: slot.room || defaultRoom,
              day: slot.day ?? 0,
              duration: '30',
              mode: 'In-person',
            })
          }
          canSchedule={access.can.scheduleVisit}
          restrictToProvider={access.ownPatientsOnly ? doctorIdentity : null}
        />

        <div className="lh-card-pad xl:lh-sticky-panel">
          <p className="lh-section-label">Visit details</p>

          <div className="mt-3 rounded-lg bg-surface/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-section font-semibold tracking-heading text-ink">{selectedAppointment.patient}</p>
                <p className="mt-0.5 text-small text-muted">{selectedAppointment.type}</p>
              </div>
              <StatusPill label={visitStatuses[selectedAppointment.id] || 'Booked'} tone={visitStatusTone[visitStatuses[selectedAppointment.id]] || 'neutral'} />
            </div>

            <div className="mt-4 space-y-2.5 text-small text-body">
              <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span>Time</span>
                <span className="font-medium text-ink">{selectedAppointment.time}</span>
              </div>
              {selectedAppointment.origin === 'walk_in' && (
                <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                  <span>Origin</span>
                  <span className="font-medium text-ink">Walk-in{selectedAppointment.arrivalTime ? `, arrived ${selectedAppointment.arrivalTime}` : ''}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span>Provider</span>
                <span className="font-medium text-ink">{selectedAppointment.provider}</span>
              </div>
              <div className="flex items-center justify-between border-b border-line/60 pb-2.5">
                <span>Room</span>
                <span className="font-medium text-ink">{selectedAppointment.room}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Mode</span>
                <span className="font-medium text-ink">{selectedAppointment.mode}</span>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between">
              <p className="lh-section-label">Visit progress</p>
              <StatusPill
                label={visitStatuses[selectedAppointment.id] || 'Booked'}
                tone={visitStatusTone[visitStatuses[selectedAppointment.id]] || 'neutral'}
              />
            </div>

            {/* A vertical stepper: six steps do not fit side by side in a
                320px panel without breaking their names across lines. */}
            <ol className="mt-3 space-y-0.5">
              {visitStatusFlow.map((step, index) => {
                const currentStatus = visitStatuses[selectedAppointment.id] || 'Booked';
                const currentIndex = visitStatusFlow.indexOf(currentStatus);
                const reached = currentIndex >= index;
                const current = currentIndex === index;
                return (
                  <li key={step} aria-current={current ? 'step' : undefined} className="relative flex items-center gap-3 py-1 pl-0.5">
                    {index < visitStatusFlow.length - 1 && (
                      <span className={`absolute left-[7px] top-[18px] h-[calc(100%-6px)] w-px ${currentIndex > index ? 'bg-brand' : 'bg-line'}`} aria-hidden="true" />
                    )}
                    <span
                      className={`relative z-10 h-3 w-3 shrink-0 rounded-full border-2 transition-colors duration-normal ${
                        current ? 'border-brand bg-brand ring-4 ring-brand/15' : reached ? 'border-brand bg-brand' : 'border-edge bg-white'
                      }`}
                      aria-hidden="true"
                    />
                    <span className={`text-small ${current ? 'font-semibold text-ink' : reached ? 'text-body' : 'text-muted'}`}>{step}</span>
                  </li>
                );
              })}
            </ol>

            <div className="mt-4 flex flex-wrap gap-2">
              {!access.can.checkIn && (
                <p className="text-small text-muted">Check-in is handled by reception and nursing staff.</p>
              )}
              {access.can.checkIn && !['Completed', 'No-show', 'Cancelled'].includes(visitStatuses[selectedAppointment.id]) && (
                <>
                  <button
                    type="button"
                    onClick={() => advanceVisitStatus(selectedAppointment.id)}
                    className="lh-btn-primary"
                  >
                    {visitStatuses[selectedAppointment.id] === 'Booked'
                      ? 'Check in patient'
                      : visitStatuses[selectedAppointment.id] === 'Checked in'
                        ? 'Start triage'
                        : visitStatuses[selectedAppointment.id] === 'In triage'
                          ? 'Mark ready'
                          : visitStatuses[selectedAppointment.id] === 'Ready for provider'
                            ? 'Start consultation'
                            : 'Complete visit'}
                  </button>
                  {visitStatuses[selectedAppointment.id] === 'Booked' && (
                    <>
                      <button
                        type="button"
                        onClick={() => markNoShow(selectedAppointment)}
                        className="lh-btn-danger"
                      >
                        Mark no show
                      </button>
                      <button
                        type="button"
                        onClick={() => cancelVisit(selectedAppointment)}
                        className="lh-btn-secondary"
                      >
                        Cancel visit
                      </button>
                    </>
                  )}
                </>
              )}
              {access.can.checkIn && ['Completed', 'No-show', 'Cancelled'].includes(visitStatuses[selectedAppointment.id]) && (
                <p className="text-small text-body">
                  {visitStatuses[selectedAppointment.id] === 'Completed'
                    ? 'Visit completed, note ready for sign off.'
                    : visitStatuses[selectedAppointment.id] === 'No-show'
                      ? 'Recorded as no show, recall message queued.'
                      : 'Visit cancelled and removed from the active flow.'}
                </p>
              )}

              {/* The visit already knows the patient, the provider and what it
                  was for. Billing it should not mean retyping any of that. */}
              {access.can.createInvoice && visitStatuses[selectedAppointment.id] === 'Completed' && (
                billed ? (
                  <p className="text-small font-medium text-success">Billed · {billed.id}</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => billVisit(selectedAppointment)}
                    className="lh-btn-primary"
                  >
                    Bill this visit
                  </button>
                )
              )}
            </div>
          </div>

          <div className="mt-6 divide-y divide-line/60 border-t border-line/60">
            {[{ title: 'Check in reminder sweep', detail: '7 patients with automated text follow up due in 20 minutes' }, { title: 'Room allocation', detail: 'Confirm room usage for afternoon consults' }, { title: 'Insurance sync', detail: '3 eligibility checks pending approval' }].map((task) => (
              <div key={task.title} className="py-3">
                <p className="text-small font-medium text-ink">{task.title}</p>
                <p className="mt-0.5 text-caption text-muted">{task.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
