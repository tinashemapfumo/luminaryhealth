/**
 * Text must never disappear into its background.
 *
 * Not a spot check on a swatch sheet — this reads the components, finds every
 * place a text colour and a background colour land on the same element, and
 * measures the pair. WCAG AA: 4.5:1 for body text, 3:1 for large text (17px and
 * above, or bold from 15px).
 *
 * It also checks every text token against the three surfaces the app actually
 * paints on — canvas, panel, surface — because most text inherits its
 * background rather than declaring one, and inherited is where contrast
 * failures hide.
 *
 *     npm run verify:contrast
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import config from '../tailwind.config.js';

// ---------------------------------------------------------------- palette
const flatten = (obj, prefix = '') => {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const name = key === 'DEFAULT' ? prefix : prefix ? `${prefix}-${key}` : key;
    if (typeof value === 'string') out[name] = value;
    else Object.assign(out, flatten(value, name));
  }
  return out;
};
const PALETTE = { ...flatten(config.theme.extend.colors), white: '#ffffff', black: '#000000' };

// ---------------------------------------------------------------- contrast
const srgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = srgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

// ---------------------------------------------------------------- sources
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** Sizes at or above this are "large text" and may use the 3:1 threshold. */
const LARGE = new Set([
  'text-lg', 'text-xl', 'text-2xl',
  'text-section', 'text-heading', 'text-page', 'text-page-lg', 'text-metric', 'text-display',
]);

const failures = [];
const pairsSeen = new Set();
let checked = 0;

for (const file of walk('src')) {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/');
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    // Each quoted run of classes is one element's worth of styling. Template
    // literals with conditionals are split on the boundaries so a class from
    // one branch is not paired with a background from another.
    for (const chunk of line.split(/[`"']|\$\{|\}|\?|:/)) {
      const classes = chunk.trim().split(/\s+/);
      const text = classes.find((c) => /^text-[a-z]/.test(c) && PALETTE[c.slice(5)]);
      const bg = classes.find((c) => /^bg-[a-z]/.test(c) && PALETTE[c.slice(3)]);
      if (!text || !bg) continue;

      const fg = PALETTE[text.slice(5)];
      const back = PALETTE[bg.slice(3)];
      const large = classes.some((c) => LARGE.has(c));
      const required = large ? 3 : 4.5;
      const ratio = contrast(fg, back);
      checked += 1;
      pairsSeen.add(`${text}|${bg}`);

      if (ratio < required) {
        failures.push({ rel, line: i + 1, text, bg, ratio, required, kind: 'explicit pair' });
      }
    }
  });
}

// --- every text token against the surfaces it will actually sit on ----------
const SURFACES = ['canvas', 'panel', 'surface', 'wash'];
const TEXT_TOKENS = ['ink', 'ink-soft', 'body', 'muted', 'faint', 'brand', 'brand-deep',
  'teal-deep', 'success', 'success-deep', 'warning', 'warning-deep', 'danger', 'danger-deep'];

for (const token of TEXT_TOKENS) {
  for (const surface of SURFACES) {
    const ratio = contrast(PALETTE[token], PALETTE[surface]);
    checked += 1;
    if (ratio < 4.5) {
      failures.push({ rel: 'palette', line: 0, text: `text-${token}`, bg: `bg-${surface}`, ratio, required: 4.5, kind: 'token on surface' });
    }
  }
}

// --- the dark sidebar has its own ground ------------------------------------
for (const token of ['shell-on', 'shell-text', 'shell-muted', 'shell-accent', 'shell-bright']) {
  const ratio = contrast(PALETTE[token], PALETTE.shell);
  checked += 1;
  // Nav labels are UI text on a dark ground; 4.5 for the ones that carry words.
  const required = token === 'shell-bright' || token === 'shell-accent' ? 3 : 4.5;
  if (ratio < required) {
    failures.push({ rel: 'palette', line: 0, text: `text-${token}`, bg: 'bg-shell', ratio, required, kind: 'sidebar' });
  }
}

// --- nothing may be painted on itself ---------------------------------------
// Deliberately narrow. Two names sharing one value is normal and often
// intended — `panel` is white, and text on ink and text on the shell are the
// same colour by design. What must never happen is a text token equal to the
// background it is actually painted on, and every such pairing is already
// measured above, where an identical value scores 1.00:1 and fails.

if (failures.length === 0) {
  console.log(`\n✓ contrast holds — ${checked} pairings checked, ${pairsSeen.size} distinct in the components\n`);
  process.exit(0);
}

console.error(`\n✗ ${failures.length} contrast failure(s):\n`);
for (const f of failures) {
  const where = f.line ? `${f.rel}:${f.line}` : f.rel;
  console.error(`  ${f.ratio.toFixed(2)}:1  needs ${f.required}:1   ${f.text} on ${f.bg}`);
  console.error(`           ${where}  (${f.kind})`);
}
console.error('');
process.exit(1);
