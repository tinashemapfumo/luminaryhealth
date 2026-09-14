import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

/**
 * Find a patient by typing.
 *
 * The dialogs used a plain `<select>` of every patient in the practice. That
 * is fine for the eight in the demo cohort and unusable at the couple of
 * thousand a real practice carries — a native select has no search beyond
 * first-letter jump, so raising an invoice for "Tendai Moyo" meant scrolling
 * past everyone whose name begins with T.
 *
 * Searches name, patient number and medical aid membership number together,
 * because those are the three things a person at the desk actually has to hand:
 * the patient says their name, produces a card with a membership number on it,
 * or quotes the number from a previous invoice. Matching only on name would
 * force reception to translate between them.
 *
 * Deliberately not fuzzy. A substring match is predictable — a receptionist
 * learns in one afternoon that typing "moy" finds Moyo — whereas an
 * approximate match that helpfully offers a different patient is a clinical
 * safety problem, not a convenience. Selecting the wrong person here bills the
 * wrong account and, in the appointment dialog, books the wrong chart.
 */

const normalise = (value) => String(value ?? '').toLowerCase().trim();

/** Name, patient number, membership number — the three a desk actually has. */
export function matchPatients(patients, query) {
  const term = normalise(query);
  if (!term) return patients;
  // Every word must match something, so "moyo ph" narrows rather than widens.
  const words = term.split(/\s+/);
  return patients.filter((patient) => {
    const haystack = normalise(`${patient.name} ${patient.id} ${patient.memberNo} ${patient.provider}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function PatientPicker({
  patients,
  value,
  onChange,
  id,
  placeholder = 'Search by name, patient number or membership number',
  emptyLabel = 'No patient in this practice matches that.',
}) {
  const reactId = useId();
  const inputId = id ?? `patient-picker-${reactId}`;
  const listId = `${inputId}-list`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef(null);
  const listRef = useRef(null);

  const matches = useMemo(() => matchPatients(patients, query), [patients, query]);
  const selected = useMemo(() => patients.find((p) => p.name === value) ?? null, [patients, value]);

  // A selection made elsewhere (a quick action that pre-fills the form) has to
  // show here too, or the field looks empty while the form holds a patient.
  useEffect(() => {
    if (!open) setQuery(selected ? selected.name : '');
  }, [selected, open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const choose = (patient) => {
    onChange(patient.name);
    setQuery(patient.name);
    setOpen(false);
  };

  const clear = () => {
    onChange('');
    setQuery('');
    setOpen(true);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (matches.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + step + matches.length) % matches.length);
      return;
    }

    if (event.key === 'Enter' && open) {
      // Only swallow Enter when it is actually choosing something. Otherwise it
      // must reach the form and submit, which is what a fast typist expects
      // after picking a patient and filling the rest in.
      if (matches[active]) {
        event.preventDefault();
        choose(matches[active]);
      }
      return;
    }

    if (event.key === 'Escape' && open) {
      // Closes the list, not the dialog. Without this the first Escape would
      // discard the half-filled form the picker is sitting in.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${matches[active].id}` : undefined}
          value={query}
          placeholder={placeholder}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full rounded-lg border border-line bg-white/75 py-2.5 pl-8 pr-8 text-xs text-ink outline-none transition placeholder:text-faint hover:border-edge focus:border-brand-bright focus:bg-white focus:ring-2 focus:ring-brand/10"
        />
        {(query || selected) && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear patient"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition hover:bg-surface hover:text-ink"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Matching patients"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-[0_18px_40px_-20px_rgba(33,97,156,0.45)]"
        >
          {matches.length === 0 ? (
            <li className="px-2.5 py-2 text-xs text-muted">{emptyLabel}</li>
          ) : (
            matches.map((patient, index) => (
              <li key={patient.id}>
                <button
                  type="button"
                  id={`${listId}-${patient.id}`}
                  role="option"
                  aria-selected={patient.name === value}
                  data-active={index === active}
                  // mousedown, not click: the input blurs on click and would
                  // close the list before the selection landed.
                  onMouseDown={(event) => { event.preventDefault(); choose(patient); }}
                  onMouseEnter={() => setActive(index)}
                  className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left transition ${
                    index === active ? 'bg-brand-soft text-ink' : 'text-ink hover:bg-surface'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{patient.name}</span>
                    <span className="mt-0.5 block truncate text-2xs text-body">
                      {patient.id}
                      {patient.memberNo ? ` · ${patient.memberNo}` : ' · Self pay'}
                    </span>
                  </span>
                  {/* The provider disambiguates the two J. Moyos every practice
                      of any size turns out to have. */}
                  {patient.provider && (
                    <span className="shrink-0 text-2xs text-muted">{patient.provider}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export default PatientPicker;
