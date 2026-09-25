import React from 'react';
import {
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileCheck2,
  Plus,
  ShieldCheck,
  Sparkles,
  UserX,
  Users,
  WalletCards,
} from 'lucide-react';
import { PERMISSIONS, metricScopeByRole } from '../../config/access';
import { buildMetrics, insightCards, tasks } from '../../data/reporting';
import { patientStatusTone } from '../../data/registry';
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
  const { access, roleInfo, currentRole, currentDate, currency, practice, todaysSchedule, visitStatuses, practiceInvoices, practiceClaims, practicePatients, configuredProviders, configuredRooms, setActiveView, setSelectedAppointment, openDialog, notify, showPermissions, setShowPermissions, requestPatientFile } = useWorkspace();
  const defaultProvider = configuredProviders[0] || 'Unassigned';
  const defaultRoom = configuredRooms[0] || 'Unassigned';

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden pb-1">
        <OceanWaveDecoration className="absolute -bottom-16 right-0 h-40 w-[360px] opacity-30" />
        <div className="relative flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="lh-page-title">Good morning, {roleInfo.person}</h1>
          <p className="lh-page-subtitle">Here is what is happening at {practice.name} today.</p>
        </div>
        <div className="flex items-center gap-3 text-small text-muted">
          <span>{currentDate}</span>
          <button type="button" className="lh-btn-secondary">
            <CalendarDays size={16} strokeWidth={1.8} />
            This week
          </button>
        </div>
        </div>
      </div>

      <div className="lh-surface-soft px-4 py-3.5">
        <div className="flex items-start gap-3">
          <ShieldCheck size={17} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand" />
          <div className="flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-small font-semibold text-ink">{roleInfo.label} access</p>
              <button
                type="button"
                onClick={() => setShowPermissions((v) => !v)}
                aria-expanded={showPermissions}
                className="text-small font-medium text-brand-deep hover:underline"
              >
                {showPermissions ? 'Hide permissions' : 'What can I do?'}
              </button>
            </div>
            <p className="mt-1 max-w-4xl text-small leading-5 text-body">{access.scopeNote}</p>
          </div>
        </div>

        {/* Staff should be able to read their own permissions, rather than
            discovering them by finding a button missing. */}
        {showPermissions && (
          <div className="mt-3.5 grid gap-5 border-t border-line/70 pt-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {['Administrative', 'Clinical', 'Financial', 'Platform'].map((group) => (
              <div key={group}>
                <p className="mb-2 text-caption font-semibold text-brand-deep">{group}</p>
                <ul className="space-y-1.5">
                  {PERMISSIONS.filter((p) => p.group === group).map((permission) => {
                    const granted = access.can[permission.key];
                    return (
                      <li key={permission.key} className="flex items-start gap-1.5 text-caption">
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

      {/* One overview of the day rather than a wall of KPI tiles: the figures
          sit side by side on a single surface, separated by hairlines. */}
      <div className="lh-card grid divide-y divide-line/60 sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 xl:divide-x">
        {buildMetrics({ schedule: todaysSchedule, invoices: practiceInvoices, claims: practiceClaims, patients: practicePatients, visitStatuses, currency })
          .filter((item) => metricScopeByRole[currentRole].includes(item.scope))
          .map((item) => {
            const MetricIcon = metricIcons[item.label] || ClipboardList;
            return (
              <div key={item.label} className="min-w-0 px-5 py-5">
                <div className="flex items-center gap-2 text-muted">
                  <MetricIcon size={16} strokeWidth={1.8} className="shrink-0 text-brand" />
                  <p className="truncate text-small font-medium">{item.label}</p>
                </div>
                <p className="lh-metric-value mt-3">{item.value}</p>
                <p className="mt-2 text-caption text-muted">{item.delta}</p>
              </div>
            );
          })}
      </div>

      {/* An administrator has no patient-directory access, so the operational
          panels below are replaced with a system-oriented view. Naming who is
          booked in today is patient data, even without a diagnosis attached. */}
      {!access.can.viewPatientDirectory && (
        <div className="lh-card-pad lh-side-panel">
          <div className="flex items-start gap-3">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <h2 className="lh-section-title">Administrator view</h2>
              <p className="mt-1.5 max-w-2xl text-copy leading-6 text-body">
                Patient and clinical panels are hidden from this role by design. Provisioning accounts and
                configuring the platform never requires seeing who is booked in today. Use <strong className="font-medium text-ink">Settings</strong> to
                manage users and configuration, and the <strong className="font-medium text-ink">Audit log</strong> to review access.
              </p>
            </div>
          </div>
        </div>
      )}

      {access.can.viewPatientDirectory && (
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
        <div className="lh-card-pad">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div>
              <p className="lh-section-label">Today’s schedule</p>
              <h2 className="lh-section-title mt-1">{currentDate}</h2>
              <p className="mt-0.5 text-small text-muted">
                {todaysSchedule.length} booked · {Object.values(visitStatuses).filter((s) => s === 'Completed').length} completed
              </p>
            </div>
            {access.can.scheduleVisit && (
              <button
                type="button"
                onClick={() => openDialog('appointment', { provider: defaultProvider, room: defaultRoom, mode: 'In-person' })}
                className="lh-btn-primary"
              >
                <Plus size={16} strokeWidth={2} />
                New appointment
              </button>
            )}
          </div>

          {todaysSchedule.length === 0 && (
            <p className="rounded-lg bg-surface/60 px-4 py-6 text-center text-small text-muted">Nothing is booked for today.</p>
          )}
          <div className="-mx-2 divide-y divide-line/60">
            {todaysSchedule.map((item) => (
              <button
                key={`${item.time}-${item.patient}`}
                type="button"
                onClick={() => {
                  const patient = practicePatients.find((p) => p.name === item.patient);
                  if (patient) {
                    requestPatientFile(patient);
                  } else {
                    setSelectedAppointment(item);
                    setActiveView('appointments');
                  }
                }}
                className="grid w-full gap-3 rounded-md px-2 py-3 text-left transition duration-fast hover:bg-brand-soft/50 md:grid-cols-[64px_1fr_auto] md:items-center"
              >
                <span className="flex items-center gap-1.5 text-small font-medium text-body tnum">
                  <Clock3 size={14} strokeWidth={1.8} className="text-brand" />
                  {item.time}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-copy font-medium text-ink">{item.patient}</span>
                  <span className="block truncate text-small text-muted">{item.type} · {item.provider} · {item.room}</span>
                </span>
                <span className="flex items-center justify-between gap-3 md:justify-end">
                  <StatusPill label={visitStatuses[item.id] || 'Booked'} tone={visitStatusTone[visitStatuses[item.id]] || 'neutral'} />
                  <ChevronRight size={16} strokeWidth={1.8} className="text-muted" />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="lh-side-panel space-y-6">
          <div className="lh-card-pad">
            <div className="flex items-center justify-between">
              <p className="lh-section-label">Practice pulse</p>
            </div>
            <div className="mt-2 divide-y divide-line/60">
              {insightCards.map((card) => (
                <div key={card.title} className="py-3.5 first:pt-2 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-small text-muted">{card.title}</p>
                    <span className="text-caption font-medium text-brand-deep tnum">{card.trend}</span>
                  </div>
                  <p className="mt-1 text-section font-semibold tracking-heading text-ink tnum">{card.value}</p>
                  <p className="mt-0.5 text-caption text-muted">{card.detail}</p>
                </div>
              ))}
            </div>
          </div>

          {/* AI output gets its own surface and says so: it is a suggestion to
              review, never something that reads like verified practice data. */}
          <div className="lh-ai-surface p-5">
            <OceanWaveDecoration className="absolute -bottom-10 right-0 h-32 w-full opacity-30" />
            <div className="relative">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-small font-semibold text-brand-deep">
                  <Sparkles size={16} strokeWidth={1.8} /> AI insights
                </p>
                <span className="text-caption text-muted">AI-generated · review before acting</span>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-white/80 p-3.5 shadow-hairline">
                  <p className="text-caption font-medium text-muted">Suggested action</p>
                  <p className="mt-1 text-copy font-semibold text-ink">Call back 4 overdue follow ups before 2pm</p>
                </div>
                <p className="px-0.5 text-small leading-5 text-body">
                  AI summary: Patients are on track, but cardiovascular follow up volume is 18% above the weekly baseline.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}


      {access.can.viewPatientDirectory && (
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
        <div className="lh-card-pad">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="lh-section-label">Patients</p>
              <h3 className="lh-section-title mt-1">Recent activity</h3>
            </div>
            <button type="button" onClick={() => setActiveView('patients')} className="lh-btn-tertiary">
              View all <ChevronRight size={16} strokeWidth={1.8} />
            </button>
          </div>

          <div className="lh-table-shell">
            <table className="min-w-full text-left text-small">
              <thead className="lh-table-head">
                <tr>
                  <th className="px-4 py-2.5 text-caption font-medium">Name</th>
                  <th className="px-4 py-2.5 text-caption font-medium">Patient ID</th>
                  <th className="px-4 py-2.5 text-caption font-medium">Next</th>
                  <th className="px-4 py-2.5 text-right text-caption font-medium">Balance</th>
                  <th className="px-4 py-2.5 text-caption font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {practicePatients.map((patient) => (
                  <tr key={patient.id} className="lh-table-row">
                    <td className="px-4 py-2.5 font-medium text-ink">{patient.name}</td>
                    <td className="px-4 py-2.5 text-body tnum">{patient.id}</td>
                    <td className="px-4 py-2.5 text-body">{patient.next}</td>
                    <td className="px-4 py-2.5 text-right text-ink tnum">{currency(patient.balance)}</td>
                    <td className="px-4 py-2.5"><StatusPill label={patient.status} tone={patientStatusTone[patient.status]} /></td>
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
              <h3 className="lh-section-title mt-1">Priority queue</h3>
            </div>
            <button
              type="button"
              aria-label="Add a task"
              onClick={() => notify('Task capture arrives with the clinical inbox')}
              className="lh-btn-icon"
            >
              <Plus size={17} strokeWidth={1.8} />
            </button>
          </div>

          <div className="divide-y divide-line/60">
            {tasks.map((task) => (
              <div key={task.title} className="py-3.5 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-copy font-medium text-ink">{task.title}</p>
                    <p className="mt-0.5 text-caption text-muted">{task.meta} · {task.time}</p>
                  </div>
                  <StatusPill label="Open" tone="warm" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
