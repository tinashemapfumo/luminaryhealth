import React from 'react';

/**
 * Nothing to show, said plainly.
 *
 * A practice with no invoices, no bookings, or no claims yet is an ordinary
 * state — the first week of using the system looks exactly like this. It was
 * previously unreachable only because every detail panel fell back to the
 * first record in the seed data, which for a second practice meant another
 * tenant's patient. Scoping that selection correctly makes the empty case
 * real, so it needs to look deliberate rather than broken.
 */
export function EmptyState({ title, detail, action }) {
  return (
    <div className="lh-card-pad flex flex-col items-center justify-center gap-2 py-14 text-center">
      <p className="text-lg font-semibold tracking-[-0.01em] text-ink">{title}</p>
      <p className="max-w-md text-sm text-body">{detail}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
