/**
 * Render check.
 *
 * A compiling module proves nothing about runtime — this codebase learned that
 * from a temporal-dead-zone bug that built cleanly and unmounted the tree on
 * load. So the workspace is actually rendered, once per seeded user, and the
 * output inspected.
 *
 * Two things are asserted:
 *
 *  1. **It renders at all.** Any throw during render fails the run, with the
 *     user it happened for.
 *  2. **Tenancy holds in the output.** Not in the access functions — in the
 *     HTML. An earlier audit passed because it exercised the functions but
 *     never looked at what was drawn, and a pasted deep link was opening
 *     another practice's chart the whole time. So this greps the rendered
 *     markup for every patient belonging to a practice the user is not in.
 *
 * Covers the shell, navigation, and the default view. Pages behind a click are
 * not reached: the view lives in component state that no effect has run to
 * change yet, and adding a prop purely so a test could reach them would be the
 * test dictating the design.
 *
 * Expect one warning in the output: `local persistence unavailable`. There is no
 * `window` here, so `lib/persistence.js` takes its guarded no-DOM path and
 * continues in memory. That warning appearing is the degradation working; its
 * absence would be the thing worth investigating.
 *
 *     npm run verify:render
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Built inside the project rather than the system temp directory: the bundle
// leaves react and lucide-react external, and a bare specifier only resolves
// from somewhere under this package.
const work = join(process.cwd(), 'node_modules', '.luminary-render');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const entry = join(work, 'entry.jsx');

// Rendered through the real component tree, not a reimplementation of it.
writeFileSync(
  entry,
  `import React from 'react';
import { renderToString } from 'react-dom/server';
import LuminaryDemo from '${process.cwd().replace(/\\/g, '/')}/src/components/LuminaryDemo.jsx';
import { users, practiceById } from '${process.cwd().replace(/\\/g, '/')}/src/data/organisation.js';
import { initialPatientRows } from '${process.cwd().replace(/\\/g, '/')}/src/data/registry.js';

export function renderFor(user) {
  return renderToString(
    React.createElement(LuminaryDemo, {
      session: { user, practice: practiceById(user.practiceId), since: new Date(0).toISOString() },
      onSignOut: () => {},
      onLock: () => {},
      auditLog: [],
      recordAudit: () => {},
    }),
  );
}

export { users, initialPatientRows };
`,
);

const outDir = join(work, 'out');
await build({
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  build: {
    ssr: entry,
    outDir,
    write: true,
    minify: false,
    // The spreadsheet parser is reached only through a dynamic import that
    // these runs never take, so it is left external rather than bundled.
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/server', 'lucide-react', 'read-excel-file/browser'] },
  },
});

const mod = await import(pathToFileURL(join(outDir, 'entry.js')).href);
const { renderFor, users, initialPatientRows } = mod;

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};

console.log(`\nRendering the workspace for ${users.length} seeded users\n`);

for (const user of users) {
  let html;
  try {
    html = renderFor(user);
  } catch (error) {
    fail(`${user.email} — threw during render: ${error.message}`);
    continue;
  }

  if (!html || html.length < 1000) {
    fail(`${user.email} — rendered ${html?.length ?? 0} bytes, which is not a workspace`);
    continue;
  }

  // The tenancy assertion: no patient from another practice may appear in the
  // markup, whatever the role. A staff-wide role is still bounded by tenant.
  const foreign = initialPatientRows
    .filter((p) => p.practiceId !== user.practiceId)
    .filter((p) => html.includes(p.name));

  if (foreign.length > 0) {
    fail(`${user.email} (${user.role}) — foreign practice patients in the output: ${foreign.map((p) => p.name).join(', ')}`);
    continue;
  }

  console.log(`  ✓ ${user.email.padEnd(34)} ${String(user.role).padEnd(13)} ${html.length.toLocaleString()} bytes, tenancy holds`);
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ ${failures} render failure(s)\n`);
  process.exit(1);
}
console.log('\n✓ every seeded user renders, and no output crosses a tenant boundary\n');
