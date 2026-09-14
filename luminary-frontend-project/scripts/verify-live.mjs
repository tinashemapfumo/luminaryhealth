/**
 * Live integration check.
 *
 * Everything else in this project is verified without a server. This one needs
 * a running API, and it is the only thing that proves the two halves actually
 * fit: it drives the real client modules — `services/api.js` and
 * `services/patients.js`, the same code the browser runs — against real
 * endpoints, and asserts the payloads become the shapes the screens render.
 *
 * Testing the endpoints alone would not do that. A server can return a
 * perfectly correct row that the mapper turns into a registry entry with an
 * undefined name, and every HTTP assertion would still pass.
 *
 * Deliberately excluded from `npm run verify`, which must work with no
 * database, no server, and no network.
 *
 *     LUMINARY_API=http://127.0.0.1:4000 \
 *     LUMINARY_PRACTICE=<uuid> \
 *     LUMINARY_EMAIL=moyo@h.co.zw \
 *     LUMINARY_PASSWORD=luminary \
 *     npm run verify:live
 *
 * The API must be running as a role WITHOUT `rolbypassrls`. Connecting it as a
 * superuser silently disables row-level security, and every tenancy assertion
 * below then passes for the wrong reason — or fails alarmingly, which is how
 * this note came to be written.
 */
import { build } from 'vite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = process.env.LUMINARY_API || 'http://127.0.0.1:4000';
const PRACTICE = process.env.LUMINARY_PRACTICE;
const EMAIL = process.env.LUMINARY_EMAIL;
const PASSWORD = process.env.LUMINARY_PASSWORD || 'luminary';

if (!PRACTICE || !EMAIL) {
  console.error('\nSet LUMINARY_PRACTICE and LUMINARY_EMAIL (see the header of this file).\n');
  process.exit(2);
}

const health = await fetch(`${API}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`\nNo API answering at ${API}. Start the server first.\n`);
  process.exit(2);
}

// The client reads `import.meta.env.VITE_API_URL`, so it has to come through a
// bundler rather than a bare import — which also means this exercises the
// module exactly as the browser receives it.
const root = process.cwd().replace(/\\/g, '/');
const work = join(process.cwd(), 'node_modules', '.luminary-live');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const entry = join(work, 'entry.js');
writeFileSync(
  entry,
  `export { api, setToken, isLive, ApiError } from '${root}/src/services/api.js';
export { rowFromApi, recordFromApi, createBodyFromForm, patchFromChanges } from '${root}/src/services/patients.js';
`,
);

await build({
  configFile: false,
  logLevel: 'error',
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API) },
  build: {
    ssr: entry,
    outDir: join(work, 'out'),
    minify: false,
    rollupOptions: { external: ['react', 'read-excel-file/browser'] },
  },
});

// `services/api.js` keeps its token in sessionStorage. There is no browser
// here, so give it the narrowest possible stand-in rather than a DOM library.
const store = new Map();
globalThis.window = {
  sessionStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const client = await import(pathToFileURL(join(work, 'out', 'entry.js')).href);
const { api, setToken, isLive, rowFromApi, recordFromApi, patchFromChanges } = client;

let fails = 0;
const ok = (label, detail) => console.log(`  ✓ ${label.padEnd(50)} ${detail ?? ''}`);
const bad = (label, detail) => { fails += 1; console.error(`  ✗ ${label.padEnd(50)} ${detail ?? ''}`); };
const expect = (label, condition, detail) => (condition ? ok(label, detail) : bad(label, detail));

console.log(`\nAgainst ${API}\n`);
expect('client reports live mode', isLive() === true);

// --- auth ---
const session = await api.auth.signIn(PRACTICE, EMAIL, PASSWORD);
setToken(session.token);
expect('signIn returns a token', typeof session.token === 'string' && session.token.length > 20);

const me = await api.auth.me();
expect('me() returns a workspace principal', Boolean(me.user?.name && me.practice?.name), `${me.user.name} · ${me.practice.short}`);
expect('initials are always present', Boolean(me.user.initials), me.user.initials);

// --- the registry, through the real mapper ---
console.log('\nRegistry\n');
const raw = await api.patients.list({ scope: 'practice' });
expect('list returns rows', Array.isArray(raw) && raw.length > 0, `${raw.length} rows`);

const rows = raw.map((p) => rowFromApi(p, me.user.practiceId));
const sample = rows[0];

expect('every row has a name', rows.every((r) => typeof r.name === 'string' && r.name.length > 0));
expect('every row has an id', rows.every((r) => Boolean(r.id)));
expect('balance is a number, not a string', rows.every((r) => typeof r.balance === 'number'));
expect('practiceId is stamped from the session', rows.every((r) => r.practiceId === me.user.practiceId));
expect('no row is missing a registry column', rows.every((r) =>
  ['lastVisit', 'next', 'status', 'provider', 'memberNo', 'coverPlan'].every((k) => r[k] !== undefined)));
console.log(`      ${sample.name} · ${sample.provider} · ${sample.coverPlan} · last ${sample.lastVisit} · next ${sample.next}`);

// The registry sorts and filters on these, so an undefined would not throw —
// it would quietly sort wrong, which is worse.
expect('no field is the string "undefined"', !JSON.stringify(rows).includes('"undefined"'));

// --- opening a chart ---
console.log('\nChart\n');
const opened = await api.patients.get(sample.patientId);
const record = recordFromApi(opened.patient);
expect('open returns a chart and its grounds', Boolean(opened.patient && opened.relationship), opened.relationship);
expect('record maps to the file shape', record.name === sample.name && Array.isArray(record.allergies));
expect('arrays are arrays even when empty', ['allergies', 'conditions', 'medications', 'immunisations', 'notes', 'timeline', 'documents']
  .every((k) => Array.isArray(record[k])));
expect('consents map to booleans', typeof record.consentTreatment === 'boolean');

// --- the patch builder ---
console.log('\nEditing\n');
const unchanged = patchFromChanges(record, record);
expect('an unchanged record produces an empty patch', Object.keys(unchanged).length === 0);

// Alternated rather than fixed, so a second run still constitutes a change —
// otherwise the patch is legitimately empty and the assertion fails on its own
// success from last time.
const nextOccupation = record.occupation === 'Radiographer' ? 'Physiotherapist' : 'Radiographer';
const edited = { ...record, occupation: nextOccupation };
const patch = patchFromChanges(record, edited);
expect('only the changed field is sent', Object.keys(patch).length === 1 && patch.occupation === nextOccupation, JSON.stringify(patch));

const updated = await api.patients.update(record.patientId, patch);
expect('the server accepts the patch', Boolean(updated), 'accepted');

const reread = recordFromApi((await api.patients.get(record.patientId)).patient);
expect('the change round-trips', reread.occupation === nextOccupation, reread.occupation);

// --- refusals reach the client as usable errors ---
console.log('\nRefusals\n');
try {
  await api.patients.get('00000000-0000-0000-0000-000000000000');
  bad('a missing patient throws');
} catch (error) {
  expect('a missing patient throws ApiError', error.name === 'ApiError', `${error.status} ${error.code}`);
}

setToken('not-a-real-token');
try {
  await api.patients.list();
  bad('a bad token is rejected');
} catch (error) {
  expect('a bad token surfaces as unauthenticated', error.isUnauthenticated === true, `${error.status}`);
}

rmSync(work, { recursive: true, force: true });

if (fails > 0) {
  console.error(`\n✗ ${fails} live check(s) failed\n`);
  process.exit(1);
}
console.log('\n✓ the client modules and the API agree\n');
