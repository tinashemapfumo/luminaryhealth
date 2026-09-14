import { useEffect, useState } from 'react';

/**
 * Minimal hash router.
 *
 * Hash rather than History API for two concrete reasons:
 *  1. The standalone single-file build runs from file://, where pushState
 *     throws a SecurityError because the document origin is null. Fragments
 *     are unaffected.
 *  2. Hash routes need no server rewrite rules, so `dist/` drops onto any
 *     static host — S3, GitHub Pages, a clinic's IIS directory — and deep
 *     links survive a refresh without configuration.
 *
 * The trade-off is uglier URLs (`/#/patients/PT-2048`). For an internal
 * clinical tool that is a fair price for working everywhere unchanged.
 */

const currentHash = () => (typeof window === 'undefined' ? '' : window.location.hash);

/** '#/patients/PT-2048/notes' -> ['patients', 'PT-2048', 'notes'] */
export function parseHash(hash) {
  const raw = hash === undefined ? currentHash() : hash;
  return String(raw || '')
    .replace(/^#/, '')
    .split('/')
    .map((segment) => decodeURIComponent(segment.trim()))
    .filter(Boolean);
}

export function buildHash(segments) {
  const path = segments.filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
  return `#/${path}`;
}

/**
 * Navigate. `replace` swaps the current entry instead of adding one — used when
 * the app corrects the URL itself, so those corrections do not become history
 * entries the user has to press Back through.
 */
export function navigate(segments, { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  const target = buildHash(segments);
  if (window.location.hash === target) return;
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, '', url);
    // replaceState does not fire hashchange, so tell listeners ourselves.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

/** Current route as an array of segments, re-rendering on back/forward. */
export function useHashRoute() {
  const [segments, setSegments] = useState(() => parseHash());

  useEffect(() => {
    const onChange = () => setSegments(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return segments;
}

/** Tab labels contain spaces and punctuation; URLs should not. */
export const toSlug = (label) =>
  String(label).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const fromSlug = (slug, options) =>
  options.find((option) => toSlug(option) === slug) || options[0];
