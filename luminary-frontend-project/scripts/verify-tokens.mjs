/**
 * The design system stays a system.
 *
 * Consolidating it was the easy half: 75 hex values became 41 named colours,
 * fifteen font sizes became eight, six radii became three. Keeping it that way
 * is the half that fails silently, because a single pasted `text-[#5a6d87]`
 * costs nothing today and there were 1,032 of them by the time anyone counted.
 *
 * So the rule is enforced rather than written down: a component may not name a
 * colour, a size, or a radius that the scale does not already have. Adding one
 * means adding it to `tailwind.config.js` on purpose.
 *
 *     npm run verify:tokens
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
};

/**
 * What is still allowed to carry a raw value, and why.
 *
 * Shadows and gradients take rgba and multi-part values that no colour token
 * can express, and the logo is an SVG whose fills are attributes rather than
 * classes. Both are narrow and both are deliberate.
 */
const ALLOWED_RAW_HEX_FILES = ['src/components/LuminaryLogo.jsx'];

const rules = [
  {
    name: 'colour',
    // `text-[#abc123]`, `bg-[#abc123]/40`, and so on — a complete arbitrary
    // colour utility. A hex inside a longer value (a shadow's rgba, a gradient
    // stop) has no closing bracket here and is not matched.
    pattern: /(?:^|[\s"'`{])(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|outline|shadow|divide|placeholder|accent|caret)-\[#[0-9a-fA-F]{3,8}\]/g,
    fix: 'name it in tailwind.config.js and use the token',
  },
  {
    name: 'font size',
    pattern: /(?:^|[\s"'`{])text-\[[0-9.]+(?:px|rem|em)\]/g,
    fix: 'use a step from the fontSize scale (2xs xs sm base md lg xl 2xl)',
  },
  {
    name: 'radius',
    pattern: /(?:^|[\s"'`{])rounded(?:-[trbl]{1,2})?-\[[0-9.]+(?:px|rem)\]/g,
    fix: 'use rounded-sm (4px), rounded (6px) or rounded-lg (8px)',
  },
];

const findings = [];

for (const file of walk('src')) {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  for (const rule of rules) {
    if (rule.name === 'colour' && ALLOWED_RAW_HEX_FILES.includes(rel)) continue;

    lines.forEach((line, index) => {
      const matches = line.match(rule.pattern);
      if (!matches) return;
      for (const match of matches) {
        findings.push({ rel, line: index + 1, rule, value: match.trim() });
      }
    });
  }
}

if (findings.length === 0) {
  console.log('\n✓ no raw colours, sizes or radii outside the scale\n');
  process.exit(0);
}

console.error(`\n✗ ${findings.length} value(s) outside the design scale:\n`);
const byRule = {};
for (const f of findings) (byRule[f.rule.name] ||= []).push(f);

for (const [name, list] of Object.entries(byRule)) {
  console.error(`  ${name} — ${list[0].rule.fix}`);
  for (const f of list.slice(0, 12)) console.error(`    ${f.rel}:${f.line}  ${f.value}`);
  if (list.length > 12) console.error(`    …and ${list.length - 12} more`);
  console.error('');
}
process.exit(1);
