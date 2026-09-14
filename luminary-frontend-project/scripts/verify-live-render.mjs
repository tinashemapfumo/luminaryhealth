import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = process.env.LUMINARY_API || 'http://127.0.0.1:4000';
const root = process.cwd().replace(/\\/g, '/');
const work = join(process.cwd(), 'node_modules', '.luminary-live-render');

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

writeFileSync(
  join(work, 'entry.jsx'),
  `import React from 'react';
import { renderToString } from 'react-dom/server';
import LuminaryDemo from '${root}/src/components/LuminaryDemo.jsx';

export function render(session) {
  return renderToString(React.createElement(LuminaryDemo, {
    session,
    onSignOut: () => {},
    onLock: () => {},
    auditLog: [],
    recordAudit: () => {},
  }));
}
`,
);

await build({
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API) },
  build: {
    ssr: join(work, 'entry.jsx'),
    outDir: join(work, 'out'),
    write: true,
    minify: false,
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/server', 'lucide-react', 'read-excel-file/browser'],
    },
  },
});

const { render } = await import(pathToFileURL(join(work, 'out', 'entry.js')).href);
const session = {
  user: {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Dr. Park',
    fullName: 'Dr S Park',
    email: 'park@h.co.zw',
    initials: 'SP',
    jobTitle: null,
    role: 'doctor',
    practiceId: '11111111-1111-1111-1111-111111111111',
    isProvider: true,
  },
  practice: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Harare Central Clinic',
    short: 'Harare Central',
    location: null,
    plan: 'starter',
  },
  since: new Date().toISOString(),
};

const html = render(session);
rmSync(work, { recursive: true, force: true });

if (!html || html.length < 1000) {
  throw new Error(`Live workspace rendered only ${html?.length ?? 0} bytes`);
}

console.log(`Live workspace rendered ${html.length.toLocaleString()} bytes`);
