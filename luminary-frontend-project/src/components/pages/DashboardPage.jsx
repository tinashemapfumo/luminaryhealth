import React from 'react';
import {
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileCheck2,
  Plus,
  ShieldCheck,
  UserX,
  Users,
  WalletCards,
} from 'lucide-react';
import { PERMISSIONS, metricScopeByRole } from '../../config/access';
import { buildMetrics, insightCards, tasks } from '../../data/reporting';
import { patientStatusTone } from '../../data/registry';
import { providerNames } from '../../data/scheduling';
import { visitStatusTone } from '../../data/clinical';
import { StatusPill } from '../shared/StatusPill';
import { OceanWaveDecoration } from '../ui';
import { useWorkspace } from '../../lib/workspace';

const metricIcons = {
  'Appointments today': CalendarDays,
  'Outstanding balance': WalletCards,
  'No shows today': UserX,
  'Claims settled': FileCheck2,
  'Patients in queue': Users,
  'Care plans active': ClipboardList,
};

export default function DashboardPage() {
  const { access, roleInfo, currentRole, currentDate, currency, practice, todaysSchedule, visitStatuses, practiceInvoices, practiceClaims, practicePatients, setActiveView, setSelectedAppointment, openDialog, notify, showPermissions, setShowPermissions } = useWorkspace();

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden pb-1">
        <OceanWaveDecoration className="absolute -bottom-16 right-0 h-40 w-[360px] opacity-30" />
        <div className="relative flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="lh-page-title">Good morning, {roleInfo.person}</h1>
          <p className="lh-page-subtitle">Here is what is happening at {practice.name} today.</p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>{currentDate}</span>
          <button className="lh-secondary-button">
            <CalendarDays size={15} />
            This week
          </button>
        </div>
        </div>
      </div>

      <div className="rounded-lg border border-line/70 bg-white/70 px-3.5 py-3 backdrop-blur">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-brand" />
          <div className="flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="lh-section-label">{roleInfo.label} access</p>
              <button
                type="button"
                onClick={() => setShowPermissions((v) => !v)}
                aria-expanded={showPermissions}
                className="text-xs font-semibold text-brand hover:underline"
              >
                {showPermissions ? 'Hide permissions' : 'What can I do?'}
              </button>
            </div>
            <p className="mt-1 text-xs leading-5 text-body">{access.scopeNote}</p>
          </div>
        </div>

        {/* Staff should be able to read their own permissions, rather than
            discovering them by finding a button missing. */}
        {showPermissions && (
          <div className="mt-3 grid gap-4 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
            {['Administrative', 'Clinical', 'Financial', 'Platform'].map((group) => (
              <div key={group}>
                <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.01em] text-brand">{group}</p>
                <ul className="space-y-1.5">
                  {PERMISSIONS.filter((p) => p.group === group).map((permission) => {
                    const granted = access.can[permission.key];
                    return (
                      <li key={permission.key} className="flex items-start gap-1.5 text-xs">
                        <span className={`mt-[2px] shrink-0 font-semibold ${granted ? 'text-success' : 'text-shell-muted'}`}>
                          {granted ? '✓' : 'Not granted'}
                        </span>
                        <span className={granted ? 'text-ink-soft' : 'text-faint'}>{permission.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {buildMetrics({ schedule: todaysSchedule, invoices: practiceInvoices, claims: practiceClaims, patients: practicePatients, visitStatuses, currency })
          .filter((item) => metricScopeByRole[currentRole].includes(item.scope))
          .map((item) => {
            const MetricIcon = metricIcons[item.label] || ClipboardList;
            return (
              <div key={item.label} className="lh-metric">
                <div className="flex items-center justify-between">
                  <p className="text-2xs font-semibold uppercase tracking-[0.01em] text-muted">{item.label}</p>
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-soft text-brand-deep">
                    <MetricIcon size={16} strokeWidth={1.9} />
                  </span>
                </div>
                <div className="mt-3 flex items-end justify-between gap-4">
                  <p className="text-xl font-semibold tracking-[-0.02em] text-ink">{item.value}</p>
                </div>
                <p className="mt-3 text-xs text-body">{item.delta}</p>
              </div>
            );
          })}
      </div>

      {/* An administrator has no patient-directory access, so the operational
          panels below are replaced with a system-oriented view. Naming who is
          booked in today is patient data, even without a diagnosis attached. */}
      {!access.can.viewPatientDirectory && (
        <div className="lh-card-pad">
          <div className="flex items-start gap-3">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <h2 className="text-md font-semibold tracking-[-0.01em] text-ink">Administrator view</h2>
              <p className="mt-1.5 max-w-2xl text-base leading-6 text-body">
                Patient and clinical panels are hidden from this role by design. Provisioning accounts and
                configuring the platform never requires seeing who is booked in today. Use <strong className="font-medium text-ink">Settings</strong> to
                manage users and configuration, and the <strong className="font-medium text-ink">Audit log</strong> to review access.
              </p>
            </div>
          </div>
        </div>
      )}

      {access.can.viewPatientDirectory && (
      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="lh-card-pad">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <p className="lh-section-label">Today’s schedule</p>
              <h2 className="mt-2 text-lg font-semibold tracking-[-0.01em] text-ink">{currentDate}</h2>
              <p className="mt-1 text-sm text-muted">
                {todaysSchedule.length} booked · {Object.values(visitStatuses).filter((s) => s === 'Completed').length} completed
              </p>
            </div>
            {access.can.scheduleVisit && (
              <button
                type="button"
                onClick={() => openDialog('appointment', { provider: providerNames[0], room: 'Room 1', mode: 'In-person' })}
                className="lh-primary-button px-3 py-2 text-sm"
              >
                <Plus size={14} />
                New appointment
              </button>
            )}
          </div>

          <div className="mt-4 divide-y divide-line">
            {todaysSchedule.map((item) => (
              <button
                key={`${item.time}-${item.patient}`}
                type="button"
                onClick={() => { setSelectedAppointment(item); setActiveView('appointments'); }}
                className="grid w-full gap-3 rounded-lg px-2 py-2.5 text-left transition hover:bg-surface md:grid-cols-[56px_1fr_auto] md:items-center"
              >
                <span className="flex items-center gap-1.5 text-base font-medium text-body">
                  <Clock3 size={13} className="text-brand" />
                  {item.time}
                </span>
                <span>
                  <span className="block text-md font-medium text-ink">{item.patient}</span>
                  <span className="block text-sm text-body">{item.type} · {item.provider} · {item.room}</span>
                </span>
                <span className="flex items-center justify-between gap-3 md:justify-end">
                  <StatusPill label={visitStatuses[item.patient] || 'Booked'} tone={visitStatusTone[visitStatuses[item.patient]] || 'neutral'} />
                  <ChevronRight size={15} className="text-muted" />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="lh-card-pad">
            <div className="flex items-center justify-between">
              <p className="lh-section-label">Practice pulse</p>
            </div>
            <div className="mt-5 space-y-4">
              {insightCards.map((card) => (
                <div key={card.title} className="lh-card-soft p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm uppercase tracking-[0.12em] text-muted">{card.title}</p>
                    <span className="text-xs text-brand-deep">{card.trend}</span>
                  </div>
                  <p className="mt-2 text-lg font-semibold tracking-[-0.01em] text-ink">{card.value}</p>
                  <p className="mt-1 text-sm text-body">{card.detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative overflow-hidden rounded-lg border border-brand-edge bg-white/90 p-4 shadow-[0_18px_44px_-34px_rgba(8,114,222,0.34)]">
            <OceanWaveDecoration className="absolute bottom-0 right-0 h-36 w-full opacity-55" />
            <div className="relative">
              <div className="flex items-center justify-between">
                <p className="text-2xs font-semibold uppercase tracking-[0.01em] text-brand-deep">AI Insights</p>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded border border-line bg-white/75 p-3 backdrop-blur-sm">
                  <p className="text-2xs font-semibold uppercase tracking-[0.01em] text-muted">Suggested action</p>
                  <p className="mt-2 text-sm font-semibold text-ink">Call back 4 overdue follow ups before 2pm</p>
                </div>
                <div className="rounded border border-line bg-surface/70 p-3 text-xs leading-5 text-body">
                  AI summary: Patients are on track, but cardiovascular follow up volume is 18% above the weekly baseline.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}


      {access.can.viewPatientDirectory && (
      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="lh-card-pad">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="lh-section-label">Patients</p>
              <h3 className="mt-2 text-lg font-semibold tracking-[-0.01em] text-ink">Recent activity</h3>
            </div>
            <button type="button" onClick={() => setActiveView('patients')} className="text-md font-medium text-brand hover:underline">View all</button>
          </div>

          <div className="lh-table-shell">
            <table className="min-w-full text-left text-md">
              <thead className="lh-table-head">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Patient ID</th>
                  <th className="px-4 py-3 font-medium">Next</th>
                  <th className="px-4 py-3 font-medium">Balance</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {practicePatients.map((patient) => (
                  <tr key={patient.id} className="border-t border-line bg-white transition hover:bg-surface">
                    <td className="px-4 py-3 font-medium text-ink">{patient.name}</td>
                    <td className="px-4 py-3 text-body">{patient.id}</td>
                    <td className="px-4 py-3 text-body">{patient.next}</td>
                    <td className="px-4 py-3 text-ink">{currency(patient.balance)}</td>
                    <td className="px-4 py-3"><StatusPill label={patient.status} tone={patientStatusTone[patient.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lh-card-pad">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="lh-section-label">Tasks</p>
              <h3 className="mt-2 text-lg font-semibold tracking-[-0.01em] text-ink">Priority queue</h3>
            </div>
            <button
              type="button"
              aria-label="Add a task"
              onClick={() => notify('Task capture arrives with the clinical inbox')}
              className="lh-icon-button"
            >
              <Plus size={14} />
            </button>
          </div>

          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.title} className="lh-card-soft p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-md font-medium text-ink">{task.title}</p>
                    <p className="mt-2 text-xs uppercase tracking-[0.12em] text-muted">{task.meta}</p>
                  </div>
                  <StatusPill label="Open" tone="warm" />
                </div>
                <p className="mt-3 text-sm text-body">{task.time}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
