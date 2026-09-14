import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

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
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white bg-brand-soft shadow-[0_6px_18px_-14px_rgba(8,114,222,0.55)] ${className}`}
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 pt-[8vh] backdrop-blur-[2px]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${width} rounded-lg border border-line bg-white/95 shadow-[0_24px_60px_-18px_rgba(33,97,156,0.28)] backdrop-blur-xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded p-1.5 text-muted transition hover:bg-surface hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

const controlClass =
  'w-full rounded-lg border border-line bg-white/75 px-3 py-2.5 text-xs text-ink outline-none transition placeholder:text-faint hover:border-edge focus:border-brand-bright focus:bg-white focus:ring-2 focus:ring-brand/10 disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted';

export function Field({ label, hint, error, children, required }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.01em] text-muted">
        {label}
        {required && <span className="text-danger">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-muted">{hint}</span>
      )}
    </label>
  );
}

export function Input(props) {
  return <input {...props} className={controlClass} />;
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
    <select {...props} className={controlClass}>
      {options.map((option) => (
        <option key={option} value={option}>
          {render ? render(option) : String(option).replace(/-/g, ' ')}
        </option>
      ))}
    </select>
  );
}

export function Textarea(props) {
  return <textarea {...props} className={`${controlClass} min-h-[84px] resize-y`} />;
}

export function Button({ variant = 'primary', children, ...props }) {
  const variants = {
    primary: 'bg-brand text-white hover:bg-brand-deep',
    secondary: 'border border-line bg-white text-ink hover:border-brand-edge',
    danger: 'border border-danger-strong bg-white text-danger hover:border-danger',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]}`}
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
      className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-brand-deep bg-ink px-4 py-2.5 text-xs font-semibold text-white shadow-[0_12px_32px_-8px_rgba(33,97,156,0.35)]"
    >
      {message}
    </div>
  );
}

/** Shown when a list has no rows — never leave a blank panel. */
export function EmptyState({ icon: Icon, title, detail, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-edge bg-surface/80 px-6 py-10 text-center">
      {Icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Icon size={18} />
        </div>
      )}
      <p className="text-md font-medium text-ink">{title}</p>
      {detail && <p className="mt-1.5 max-w-sm text-sm leading-5 text-muted">{detail}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
