import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';

export function OceanWaveDecoration({ className = '' }) {
  return (
    <svg
      className={`pointer-events-none ${className}`}
      viewBox="0 0 520 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M-42 126C18 76 73 82 129 121C184 159 228 174 293 119C359 63 415 59 558 21V240H-42V126Z" fill="url(#waveA)" opacity=".32" />
      <path d="M-48 150C22 93 86 107 151 142C218 178 268 170 336 109C407 46 464 73 562 39V240H-48V150Z" fill="url(#waveB)" opacity=".46" />
      <path d="M-44 171C26 122 88 139 158 168C226 196 283 186 351 133C421 78 476 101 560 72V240H-44V171Z" fill="url(#waveC)" opacity=".54" />
      <path d="M-40 190C32 143 95 164 163 188C233 213 297 202 371 158C438 118 492 128 560 101V240H-40V190Z" fill="url(#waveD)" opacity=".5" />
      <path d="M-36 207C38 172 103 190 174 207C246 224 318 215 392 184C462 155 507 165 558 137V240H-36V207Z" fill="url(#waveE)" opacity=".64" />
      <path d="M-38 220C50 196 118 210 188 219C270 230 343 221 423 202C483 188 523 185 560 165V240H-38V220Z" fill="url(#waveF)" opacity=".34" />
      <defs>
        <linearGradient id="waveA" x1="-18" y1="82" x2="520" y2="136" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2188F5" />
          <stop offset=".52" stopColor="#8FC7FF" />
          <stop offset="1" stopColor="#EFF7FF" stopOpacity=".34" />
        </linearGradient>
        <linearGradient id="waveB" x1="-20" y1="104" x2="528" y2="160" gradientUnits="userSpaceOnUse">
          <stop stopColor="#56A8FF" />
          <stop offset=".58" stopColor="#BFDEFF" />
          <stop offset="1" stopColor="#F7FAFE" stopOpacity=".22" />
        </linearGradient>
        <linearGradient id="waveC" x1="-12" y1="136" x2="520" y2="178" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8FC7FF" />
          <stop offset=".55" stopColor="#DDEEFF" />
          <stop offset="1" stopColor="#F7FAFE" stopOpacity=".16" />
        </linearGradient>
        <linearGradient id="waveD" x1="-24" y1="160" x2="520" y2="196" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0872DE" />
          <stop offset=".45" stopColor="#56A8FF" />
          <stop offset="1" stopColor="#EFF7FF" stopOpacity=".12" />
        </linearGradient>
        <linearGradient id="waveE" x1="-18" y1="185" x2="522" y2="213" gradientUnits="userSpaceOnUse">
          <stop stopColor="#075EB8" />
          <stop offset=".36" stopColor="#2188F5" />
          <stop offset=".78" stopColor="#BFDEFF" />
          <stop offset="1" stopColor="#F7FAFE" stopOpacity=".1" />
        </linearGradient>
        <linearGradient id="waveF" x1="-24" y1="205" x2="522" y2="225" gradientUnits="userSpaceOnUse">
          <stop stopColor="#075EB8" />
          <stop offset=".46" stopColor="#56A8FF" />
          <stop offset="1" stopColor="#EFF7FF" stopOpacity=".08" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function HumanAvatar({ initials, label = 'User avatar', className = '' }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white bg-brand-soft shadow-control ${className}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 40 40" className="h-full w-full" aria-hidden="true">
        <rect width="40" height="40" rx="20" fill="#EFF7FF" />
        <path d="M6 35C10.5 28.8 15 26 20 26C25 26 29.5 28.8 34 35V40H6V35Z" fill="#0872DE" opacity=".82" />
        <circle cx="20" cy="17" r="9" fill="#F2C5A8" />
        <path d="M11.7 15.6C12.4 9.8 15.6 6.5 20.4 6.5C25.2 6.5 28.8 9.9 29.2 15.5C26.2 13.6 23.3 12.7 20.6 12.7C17.6 12.7 14.6 13.7 11.7 15.6Z" fill="#10233F" />
        <circle cx="16.7" cy="17.7" r="1" fill="#10233F" />
        <circle cx="23.3" cy="17.7" r="1" fill="#10233F" />
        <path d="M17.4 21.3C19 22.5 21.1 22.5 22.6 21.3" stroke="#10233F" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {initials && (
        <span className="absolute bottom-0 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-white bg-white px-0.5 text-2xs font-semibold leading-none text-brand-deep">
          {initials.slice(0, 2)}
        </span>
      )}
    </span>
  );
}

/**
 * Overlay dialog. Closes on Escape and on backdrop click, moves focus to the
 * first field on open, and restores focus to the trigger on close — the
 * baseline a keyboard user needs to not get stranded.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-lg' }) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !panelRef.current) return;
      // Keep Tab inside the dialog while it is open.
      const focusables = panelRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector('input, select, textarea');
      if (target) target.focus();
    }, 30);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="lh-backdrop fixed inset-0 z-modal flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`lh-modal relative w-full ${width}`}
      >
        <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div className="min-w-0">
            <h2 className="text-section font-semibold tracking-heading text-ink">{title}</h2>
            {subtitle && <p className="mt-1 text-small leading-5 text-body">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-2 -mt-1 inline-flex h-control-sm w-control-sm shrink-0 items-center justify-center rounded-full text-muted transition duration-fast hover:bg-ink/5 hover:text-ink"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div className="px-6 pb-5 pt-2">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 rounded-b-4xl border-t border-line/60 bg-surface/50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Form field. Labels are sentence case at caption size — the words carry the
 * meaning, so they no longer need to shout in 9px capitals to be found.
 */
export function Field({ label, hint, error, children, required }) {
  return (
    <label className="block">
      <span className="lh-label">
        {label}
        {required && <span className="text-danger" aria-hidden="true">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-caption text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1.5 block text-caption text-muted">{hint}</span>
      )}
    </label>
  );
}

export function Input(props) {
  return <input {...props} className="lh-input" />;
}

/**
 * `render` maps an option's value to its label, for the cases where the two
 * differ — a tariff code is what the form stores and "99213 · Office visit,
 * established patient · USD 40.00" is what a person needs to read to choose it.
 * Without it the value has to double as the label, which is why every select in
 * the workspace used to be a list of bare strings.
 */
export function Select({ options, render, ...props }) {
  return (
    <select {...props} className="lh-select">
      {options.map((option) => (
        <option key={option} value={option}>
          {render ? render(option) : String(option).replace(/-/g, ' ')}
        </option>
      ))}
    </select>
  );
}

export function Textarea(props) {
  return <textarea {...props} className="lh-textarea" />;
}

const BUTTON_VARIANTS = {
  primary: 'lh-btn-primary',
  secondary: 'lh-btn-secondary',
  tertiary: 'lh-btn-tertiary',
  danger: 'lh-btn-danger',
  'danger-solid': 'lh-btn-danger-solid',
};

/**
 * `danger` stays an outline on purpose: most destructive actions open a
 * confirmation, and the solid red belongs to the button inside it
 * (`danger-solid`), where the decision is actually being made.
 */
export function Button({ variant = 'primary', className = '', children, ...props }) {
  return (
    <button
      {...props}
      className={`${BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

/** Transient confirmation that an action landed. */
export function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-toast flex max-w-[calc(100vw-2rem)] animate-toast-in items-center gap-2.5 rounded-xl border border-white/10 bg-ink/90 py-2.5 pl-3 pr-4 text-small font-medium text-white shadow-float backdrop-blur-glass"
      style={{ transform: 'translateX(-50%)' }}
    >
      <Info size={16} strokeWidth={1.8} className="shrink-0 text-brand-edge" aria-hidden="true" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

/**
 * Shown when a list has no rows — never leave a blank panel. Quiet on
 * purpose: an empty queue is an ordinary state, not an event.
 */
export function EmptyState({ icon: Icon, title, detail, action }) {
  return (
    <div className="lh-surface-soft flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-brand shadow-hairline">
          <Icon size={20} strokeWidth={1.7} />
        </div>
      )}
      <p className="text-copy font-semibold text-ink">{title}</p>
      {detail && <p className="mt-1.5 max-w-sm text-small leading-5 text-muted">{detail}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Apple-style segmented control: one shared track, with a capsule that slides
 * to the selected option. Options are `{ value, label, icon? }` or plain
 * strings. Arrow keys move the selection, as they do in a radio group.
 */
export function SegmentedControl({ options, value, onChange, label, size = 'md', className = '' }) {
  const items = options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
  const trackRef = useRef(null);
  const [thumb, setThumb] = useState(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const measure = () => {
      const selected = track.querySelector('[aria-checked="true"]');
      setThumb(selected ? { left: selected.offsetLeft, width: selected.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, options]);

  const onKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.value === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = items[(index + step + items.length) % items.length];
    onChange?.(next.value);
    trackRef.current?.querySelector(`[data-value="${CSS.escape(String(next.value))}"]`)?.focus();
  };

  return (
    <div ref={trackRef} role="radiogroup" aria-label={label} className={`lh-segmented ${className}`} onKeyDown={onKeyDown}>
      {thumb && <span className="lh-segmented-thumb" style={{ left: thumb.left, width: thumb.width }} aria-hidden="true" />}
      {items.map((item) => {
        const selected = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-value={item.value}
            onClick={() => onChange?.(item.value)}
            className={`lh-segmented-item ${size === 'sm' ? 'h-7 px-2.5 text-caption' : ''}`}
          >
            {Icon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Underlined tab bar for larger tab sets (the patient file's ten tabs) — it
 * scrolls horizontally instead of squeezing, which a segmented control cannot.
 */
export function Tabs({ tabs, value, onChange, label, className = '' }) {
  const items = tabs.map((tab) => (typeof tab === 'string' ? { value: tab, label: tab } : tab));
  return (
    <div role="tablist" aria-label={label} className={`lh-tabs ${className}`}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={item.value === value}
            onClick={() => onChange?.(item.value)}
            className="lh-tab"
          >
            {Icon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
            {item.label}
            {item.count != null && <span className="text-caption tnum text-muted">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A figure and what it measures. Unframed by default so a row of them reads
 * as one overview rather than a wall of KPI tiles; `framed` for when a metric
 * genuinely stands alone.
 */
export function Metric({ value, label, detail, icon: Icon, tone = 'neutral', framed = false }) {
  const toneClass = { neutral: 'text-ink', alert: 'text-danger', warm: 'text-warning', success: 'text-success' }[tone] || 'text-ink';
  return (
    <div className={framed ? 'lh-metric' : 'min-w-0'}>
      {Icon && (
        <div className="lh-metric-icon mb-3">
          <Icon size={16} strokeWidth={1.8} />
        </div>
      )}
      <p className={`lh-metric-value ${toneClass}`}>{value}</p>
      <p className="lh-metric-label">{label}</p>
      {detail && <p className="mt-0.5 text-caption text-muted">{detail}</p>}
    </div>
  );
}

/** Neutral count or tag. Status belongs to StatusPill, which carries tone. */
export function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink/[0.06] px-1.5 text-xs font-medium tnum text-body ${className}`}>
      {children}
    </span>
  );
}

/** Placeholder block while content loads. Prefer this to a spinner. */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <span className={`lh-skeleton block ${className}`} aria-hidden="true" />;
}

/**
 * A page toolbar that pins under the workspace chrome while the page scrolls.
 * It sticks at `top: -1px`, so the moment it pins one pixel is clipped by the
 * scroller and its intersection ratio drops below 1 — that is when the
 * hairline and shadow appear. At rest it sits flush with the page instead of
 * looking like a band across it.
 */
export function StickyBar({ children, className = '', label }) {
  const barRef = useRef(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top < window.innerHeight / 2),
      { threshold: [1] },
    );
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={barRef} role={label ? 'region' : undefined} aria-label={label} data-stuck={stuck} className={`lh-sticky-bar ${className}`}>
      {children}
    </div>
  );
}
