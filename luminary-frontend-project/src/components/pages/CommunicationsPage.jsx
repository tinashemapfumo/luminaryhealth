import React from 'react';
import { Plus } from 'lucide-react';
import { messageTemplates, reminderCampaigns } from '../../data/engagement';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';

export default function CommunicationsPage() {
  const { access, openDialog, exportCsv, practiceMessages } = useWorkspace();

  return (
    <div className="space-y-6">
      <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="lh-page-kicker">Engagement</p>
          <h1 className="lh-page-title">Communications center</h1>
          <p className="lh-page-subtitle">Patient messaging, campaigns, and the template library, with every send logged.</p>
        </div>
        {access.can.sendMessages && (
          <button type="button" onClick={() => openDialog('message', { channel: 'SMS', type: 'Manual message' })} className="lh-primary-button">
            <Plus size={14} />
            New message
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: 'Messages sent today', value: '148', detail: '96% delivered' },
          { label: 'Confirmations received', value: '19 / 24', detail: 'Today’s appointments' },
          { label: 'Recall bookings', value: '23', detail: 'From recall campaigns this month' },
        ].map((item) => (
          <div key={item.label} className="lh-metric">
            <p className="lh-section-label">{item.label}</p>
            <p className="mt-3 text-xl font-semibold tracking-title text-ink">{item.value}</p>
            <p className="mt-2 text-sm text-body">{item.detail}</p>
          </div>
        ))}
      </div>

      <div className="grid min-w-0 items-start gap-6 2xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div className="lh-card-pad">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="lh-section-label">Message log</p>
              <h2 className="mt-2 text-lg font-semibold tracking-heading text-ink">Recent outreach</h2>
            </div>
            <button type="button" onClick={() => exportCsv('message-log.csv', [{ label: 'Patient', get: (r) => r.patient }, { label: 'Channel', get: (r) => r.channel }, { label: 'Type', get: (r) => r.type }, { label: 'Message', get: (r) => r.message }, { label: 'Status', get: (r) => r.status }, { label: 'Time', get: (r) => r.time }], practiceMessages)} className="lh-secondary-button">Export log</button>
          </div>
          <div className="space-y-3">
            {practiceMessages.map((entry) => (
              <div key={`${entry.patient}-${entry.type}`} className="lh-list-row p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-md font-medium text-ink">{entry.patient}</p>
                    <p className="mt-1 text-caption font-medium text-muted">{entry.channel} · {entry.type}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <StatusPill label={entry.status} tone={entry.tone} />
                    <span className="text-xs text-muted">{entry.time}</span>
                  </div>
                </div>
                <p className="mt-2.5 rounded-lg border border-line bg-white p-2.5 text-sm leading-5 text-body">{entry.message}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="lh-side-panel space-y-6">
          <div className="lh-card-pad">
            <p className="lh-section-label">Active campaigns</p>
            <div className="mt-4 space-y-3">
              {reminderCampaigns.map((campaign) => (
                <div key={campaign.name} className="lh-card-soft p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-medium text-ink">{campaign.name}</p>
                      <p className="mt-1 text-xs text-body">{campaign.audience}</p>
                    </div>
                    <span className="text-sm font-medium text-brand">{campaign.progress}%</span>
                  </div>
                  <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-line">
                    <div className={`h-full rounded-full ${campaign.tone === 'success' ? 'bg-success-bright' : campaign.tone === 'warm' ? 'bg-warning-bright' : 'bg-brand-bright'}`} style={{ width: `${campaign.progress}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-muted">{campaign.detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="lh-card-pad">
            <div className="flex items-center justify-between">
              <p className="lh-section-label">Message templates</p>
              <button
                type="button"
                aria-label="New message template"
                onClick={() => openDialog('message', { channel: 'SMS', type: 'Manual message' })}
                className="lh-icon-button h-8 w-8"
              >
                <Plus size={13} />
              </button>
            </div>
            <div className="mt-4 space-y-2.5">
              {messageTemplates.map((template) => (
                <div key={template.name} className="flex items-center justify-between rounded-lg border border-line bg-white p-3 transition hover:border-brand-bright hover:bg-surface">
                  <div>
                    <p className="text-base font-medium text-ink">{template.name}</p>
                    <p className="mt-1 text-xs text-body">{template.channel} · {template.usage}</p>
                  </div>
                  <StatusPill label={template.status} tone={template.status === 'Active' ? 'success' : 'neutral'} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
