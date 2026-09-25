import React from 'react';

/**
 * Status communicates information, it does not decorate. Soft fill, semantic
 * text, a hairline ring in the same family. Sentence case is applied with
 * `first-letter:uppercase` rather than by rewriting the label, so the text in
 * the DOM — what screen readers announce and what tests match — is unchanged.
 */
export function StatusPill({ label, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-ink/[0.05] text-body ring-line',
    warm: 'bg-warning-soft text-warning ring-warning-line/70',
    accent: 'bg-teal-soft text-teal-deep ring-teal-line/70',
    success: 'bg-success-soft text-success ring-success-line/70',
    alert: 'bg-danger-soft text-danger-deep ring-danger-line',
  };

  return (
    <span className={`lh-pill ${tones[tone] || tones.neutral}`}>
      <span className="inline-block first-letter:uppercase">{String(label).replace(/-/g, ' ')}</span>
    </span>
  );
}
