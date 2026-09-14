import { useCallback, useEffect, useState } from 'react';

/**
 * Local persistence.
 *
 * A stand-in for the server, not a design for it. Everything here exists so the
 * workspace survives a refresh — which matters most for the audit log: an
 * append-only compliance record that vanishes on F5 is worse than none,
 * because it creates false assurance.
 *
 * Deliberate limits:
 *  - Stored under one namespace, mirroring the in-memory model where all
 *    tenants live in one collection and scoping happens at read time. A real
 *    backend scopes by tenant in the query, not in the client.
 *  - Versioned. A schema change bumps VERSION and the old payload is dropped
 *    rather than half-read into a shape the code no longer understands.
 *  - Every access is guarded. localStorage throws in private mode, when the
 *    quota is exceeded, and when a browser blocks site data — none of which
 *    should take the application down.
 */

const NAMESPACE = 'luminary';
// v2: invoices carry issuedOn/dueOn and an adjustments ledger
// v3: money is denominated in the practice's configured currency — invoices
//     state `currency` explicitly instead of defaulting to ZWL, and the seed
//     amounts are USD. A v2 payload read as v3 would render ZWL-era figures
//     under a USD label, which is the one migration failure worth avoiding at
//     any cost: silently wrong money is worse than no money at all.
// v4: invoice lines carry the funder model (gross, estimatedFunder, and the
//     separate actualFunderApproved/Paid), and the service catalogue, payers
//     and tariff schedules became stored collections of their own. A v3 line
//     read as v4 would report a gross of zero on every invoice.
// v5: the demo cohort was localised to Zimbabwean patient names across the
//     registry, schedule, claims, billing, records, communications, and orders.
//     Existing browser storage is dropped so the UI does not keep old names.
const VERSION = 5;

const keyFor = (name) => `${NAMESPACE}:v${VERSION}:${name}`;
const hasLocalStorage = () => typeof window !== 'undefined' && Boolean(window.localStorage);

let warned = false;
const warnOnce = (error) => {
  if (warned) return;
  warned = true;
  console.warn('Luminary: local persistence unavailable, continuing in memory only.', error);
};

export function isAvailable() {
  if (!hasLocalStorage()) return false;
  try {
    const probe = `${NAMESPACE}:probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readValue(name, fallback) {
  if (!hasLocalStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(keyFor(name));
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch (error) {
    warnOnce(error);
    return fallback;
  }
}

export function writeValue(name, value) {
  if (!hasLocalStorage()) return false;
  try {
    window.localStorage.setItem(keyFor(name), JSON.stringify(value));
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

/** Drops this version's data. Older versions are swept too, so upgrades tidy up. */
export function clearAll() {
  if (!hasLocalStorage()) return false;
  try {
    const doomed = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`${NAMESPACE}:`)) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

/** How much has been stored, for the reset dialog to report honestly. */
export function storageSummary() {
  if (!hasLocalStorage()) return { entries: 0, kb: 0 };
  try {
    let bytes = 0;
    let entries = 0;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(`${NAMESPACE}:`)) continue;
      entries += 1;
      bytes += (window.localStorage.getItem(key) || '').length + key.length;
    }
    return { entries, kb: Math.round((bytes / 1024) * 10) / 10 };
  } catch {
    return { entries: 0, kb: 0 };
  }
}

/**
 * useState that writes through to local storage.
 *
 * The initialiser runs once; the stored value wins over the seed when present,
 * so a returning user sees their own data rather than the demo cohort.
 */
export function usePersistentState(name, seed) {
  const [value, setValue] = useState(() =>
    readValue(name, typeof seed === 'function' ? seed() : seed)
  );

  useEffect(() => {
    writeValue(name, value);
  }, [name, value]);

  const reset = useCallback(() => {
    setValue(typeof seed === 'function' ? seed() : seed);
    // seed is a stable module-level constant in every current call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  return [value, setValue, reset];
}
