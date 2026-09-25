import React from 'react';
import { Plus } from 'lucide-react';
import { messageTemplates, reminderCampaigns } from '../../data/engagement';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';

/** Channels are identifiers: SMS is an acronym, WhatsApp a brand. */
const channelLabel = (channel) => ({ sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' }[String(channel || '').toLowerCase()] || channel);

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

      <div className="lh-card grid divide-y divide-line/60 md:grid-cols-3 md:divide-x md:divide-y-0">
        {[
          { label: 'Messages sent today', value: '148', detail: '96% delivered' },
          { label: 'Confirmations received', value: '19 / 24', detail: 'Today’s appointments' },
          { label: 'Recall bookings', value: '23', detail: 'From recall campaigns this month' },
        ].map((item) => (
          <div key={item.label} className="min-w-0 px-5 py-5">
            <p className="text-small font-medium text-muted">{item.label}</p>
            <p className="lh-metric-value mt-2">{item.value}</p>
            <p className="mt-1.5 text-caption text-muted">{item.detail}</p>
          </div>
        ))}
      </div>

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
        <div className="lh-card-pad">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="lh-section-label">Message log</p>
              <h2 className="lh-section-title mt-1">Recent outreach</h2>
            </div>
            <button type="button" onClick={() => exportCsv('message-log.csv', [{ label: 'Patient', get: (r) => r.patient }, { label: 'Channel', get: (r) => r.channel }, { label: 'Type', get: (r) => r.type }, { label: 'Message', get: (r) => r.message }, { label: 'Status', get: (r) => r.status }, { label: 'Time', get: (r) => r.time }], practiceMessages)} className="lh-secondary-button">Export log</button>
          </div>
          <div className="divide-y divide-line/60">
            {practiceMessages.map((entry) => (
              <div key={`${entry.patient}-${entry.type}`} className="py-3.5 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-copy font-medium text-ink">{entry.patient}</p>
                    <p className="mt-0.5 text-caption text-muted">{channelLabel(entry.channel)} · {entry.type}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-caption text-muted tnum">{entry.time}</span>
                    <StatusPill label={entry.status} tone={entry.tone} />
                  </div>
                </div>
                <p className="mt-2 max-w-3xl rounded-lg rounded-tl-xs bg-surface/80 px-3.5 py-2.5 text-small leading-5 text-body">{entry.message}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6 xl:lh-sticky-panel">
          <div className="lh-card-pad">
            <p className="lh-section-label">Active campaigns</p>
            <div className="mt-2 divide-y divide-line/60">
              {reminderCampaigns.map((campaign) => (
                <div key={campaign.name} className="py-3.5 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-small font-medium text-ink">{campaign.name}</p>
                      <p className="mt-0.5 text-caption text-muted">{campaign.audience}</p>
                    </div>
                    <span className="text-small font-semibold text-brand-deep tnum">{campaign.progress}%</span>
                  </div>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
                    <div className={`h-full rounded-full ${campaign.tone === 'success' ? 'bg-success-bright' : campaign.tone === 'warm' ? 'bg-warning-bright' : 'bg-brand-bright'}`} style={{ width: `${campaign.progress}%` }} />
                  </div>
                  <p className="mt-2 text-caption text-muted">{campaign.detail}</p>
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
                className="lh-btn-icon h-8 w-8"
              >
                <Plus size={17} strokeWidth={1.8} />
              </button>
            </div>
            <div className="-mx-2 mt-2">
              {messageTemplates.map((template) => (
                <div key={template.name} className="flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition duration-fast hover:bg-brand-soft/50">
                  <div className="min-w-0">
                    <p className="text-small font-medium text-ink">{template.name}</p>
                    <p className="mt-0.5 text-caption text-muted">{channelLabel(template.channel)} · {template.usage}</p>
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
