import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { AUDIT, usersInPractice } from '../../data/organisation';
import { formatAuditTime } from '../../lib/access';
import { EmptyState } from '../ui';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';

export default function AuditPage() {
  const { auditLog, currentUser, practice, grants, practicePatients } = useWorkspace();

  const scoped = auditLog.filter((entry) => entry.practiceId === currentUser.practiceId);
  const breakGlass = scoped.filter((entry) => entry.severity === AUDIT.ALERT);
  const practiceGrants = grants.filter((grant) => grant.practiceId === currentUser.practiceId);

  return (
    <div className="space-y-5">
      <div className="lh-page-hero">
        <p className="lh-page-kicker">Compliance</p>
        <h1 className="lh-page-title">Audit log</h1>
        <p className="lh-page-subtitle">
          Append-only record of who accessed what, and why, in {practice.name}. Nothing here can be edited or removed.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          { label: 'Events this session', value: scoped.length, tone: 'neutral' },
          { label: 'Break-glass accesses', value: breakGlass.length, tone: breakGlass.length ? 'alert' : 'success' },
          { label: 'Active temporary grants', value: practiceGrants.length, tone: 'neutral' },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-lg border border-line/70 bg-white/80 px-3.5 py-3 shadow-[0_7px_22px_-20px_rgba(33,97,156,0.18)] backdrop-blur"
          >
            <p className="lh-section-label">{tile.label}</p>
            <p className={`mt-1.5 text-xl font-semibold tracking-title ${tile.tone === 'alert' ? 'text-danger' : 'text-ink'}`}>
              {tile.value}
            </p>
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-line/60 bg-white/55 px-3.5 py-3 backdrop-blur">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-heading text-ink">Access grants</h2>
          <span className="text-xs text-muted">Standing and temporary</span>
        </div>
        {practiceGrants.length === 0 ? (
          <p className="text-xs text-muted">No grants in force.</p>
        ) : (
          <div className="divide-y divide-line">
            {practiceGrants.map((grant) => {
              const holder = usersInPractice(currentUser.practiceId).find((user) => user.id === grant.userId);
              const subject = practicePatients.find((patient) => patient.id === grant.patientId);
              return (
                <div key={grant.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
                  <div>
                    <p className="text-xs font-semibold text-ink">
                      {holder?.name || grant.userId} to {subject?.name || grant.patientId}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{grant.reason}</p>
                  </div>
                  <div className="text-right">
                    <StatusPill label={grant.type} tone={grant.type === 'Break-glass' ? 'alert' : 'warm'} />
                    <p className="mt-1 text-2xs text-muted">
                      until {new Date(grant.until).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-heading text-ink">Event trail</h2>
        {scoped.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No events yet" detail="Access and changes will appear here as they happen." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line/70 bg-white/75 backdrop-blur">
            <table className="min-w-full text-left text-md">
              <thead className="bg-white/45 text-2xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">When</th>
                  <th className="px-4 py-2.5 font-semibold">Who</th>
                  <th className="px-4 py-2.5 font-semibold">Action</th>
                  <th className="px-4 py-2.5 font-semibold">Subject</th>
                  <th className="px-4 py-2.5 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {scoped.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`border-t border-line/70 transition hover:bg-brand-soft/50 ${entry.severity === AUDIT.ALERT ? 'bg-danger-soft' : 'bg-white/60'}`}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 text-body">{formatAuditTime(entry.at)}</td>
                    <td className="px-4 py-2.5 font-medium text-ink">{entry.userName}</td>
                    <td className="px-4 py-2.5">
                      <span className={entry.severity === AUDIT.ALERT ? 'font-semibold text-danger' : 'text-ink-soft'}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-body">{entry.subject || '-'}</td>
                    <td className="max-w-[320px] px-4 py-2.5 text-xs text-muted">{entry.detail || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
