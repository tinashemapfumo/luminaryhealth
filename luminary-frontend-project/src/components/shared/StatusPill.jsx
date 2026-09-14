import React from 'react';

export function StatusPill({ label, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-line text-body',
    warm: 'bg-warning-wash text-warning',
    accent: 'bg-teal-soft text-teal-deep',
    success: 'bg-success-soft text-success',
    alert: 'bg-danger-soft text-danger',
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-2xs font-medium tracking-[0.08em] uppercase ${tones[tone] || tones.neutral}`}>{String(label).replace(/-/g, ' ')}</span>;
}
