import React from 'react';

/**
 * Luminary Health brand mark.
 *
 * Two skewed, rounded panels — teal above, azure below — overlapping so the
 * multiply blend deepens the intersection, with an upright white cross set in
 * the overlap. Drawn as inline SVG so it stays crisp at any size, inherits no
 * external assets, and can be recoloured for dark surfaces via `onDark`.
 */
export function LuminaryMark({ size = 40, onDark = false, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Luminary Health"
    >
      <g transform="translate(8.5,1) skewX(-14)">
        <rect x="0" y="3" width="20" height="20" rx="6" fill={onDark ? '#8fc7ff' : '#56a8ff'} />
        <rect x="6" y="11" width="20" height="20" rx="6" fill="#0872de" style={{ mixBlendMode: 'multiply' }} />
      </g>
      <rect x="15.8" y="13" width="3.6" height="11" rx="1.1" fill="#ffffff" />
      <rect x="12" y="16.7" width="11" height="3.6" rx="1.1" fill="#ffffff" />
    </svg>
  );
}

/**
 * Full lockup: mark plus the two-tone wordmark.
 * `stacked` renders LUMINARY over HEALTH as in the primary logo.
 */
export function LuminaryLogo({ size = 36, onDark = false, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LuminaryMark size={size} onDark={onDark} />
      <div className="leading-none">
        <p
          className="text-md font-semibold uppercase tracking-[0.16em]"
          style={{ color: onDark ? '#edf3fa' : '#10233f' }}
        >
          Luminary
        </p>
        <p
          className="mt-1 text-2xs font-medium uppercase tracking-[0.34em]"
          style={{ color: onDark ? '#86c7ff' : '#0872de' }}
        >
          Health
        </p>
      </div>
    </div>
  );
}

export default LuminaryLogo;
