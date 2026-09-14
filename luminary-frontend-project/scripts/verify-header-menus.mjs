/**
 * Interaction check for the header menus.
 *
 * Written because the account menu was reported as not working properly, and
 * the cause was invisible to every other check here: it built, it linted, it
 * server-rendered identically. The bug only existed once two menus and a mouse
 * were involved.
 *
 * What was wrong: the alerts menu and the account menu each rendered their own
 * full-screen backdrop at `z-30` to catch outside clicks, while their trigger
 * buttons sat at `z-index: auto`. Positive z-index paints above auto, so the
 * open menu's backdrop covered *both* triggers. Clicking the account button
 * while alerts were open hit the backdrop instead of the button — the first
 * menu closed, the second never opened, and every switch between them cost two
 * clicks.
 *
 * Rendering alone cannot catch that, so this drives real clicks in a real DOM.
 *
 *     npm run verify:menus
 */
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd().replace(/\\/g, '/');
const work = join(process.cwd(), 'node_modules', '.luminary-menus');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const entry = join(work, 'entry.jsx');
writeFileSync(
  entry,
  `import React from 'react';
import { createRoot } from 'react-dom/client';
import LuminaryDemo from '${root}/src/components/LuminaryDemo.jsx';
import { users, practiceById } from '${root}/src/data/organisation.js';

export function mount(container, user) {
  const root = createRoot(container);
  root.render(
    React.createElement(LuminaryDemo, {
      session: { user, practice: practiceById(user.practiceId), since: new Date(0).toISOString() },
      onSignOut: () => {},
      onLock: () => {},
      auditLog: [],
      recordAudit: () => {},
    }),
  );
  return root;
}
export { users };
`,
);

await build({
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('') },
  build: {
    ssr: entry,
    outDir: join(work, 'out'),
    minify: false,
    // The spreadsheet parser is reached only through a dynamic import that
    // these runs never take, so it is left external rather than bundled.
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'read-excel-file/browser'] },
  },
});

// A DOM must exist before React is imported, since it reads globals on load.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
// Node 21+ defines `navigator` as a getter-only global, so it is assigned
// through defineProperty rather than plain assignment.
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'HashChangeEvent', 'CustomEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage']) {
  const value = key === 'window' ? dom.window : dom.window[key];
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
const { mount, users } = await import(pathToFileURL(join(work, 'out', 'entry.js')).href);

/**
 * Let React finish.
 *
 * `act()` is unavailable here — the bundle externalises React and Node resolves
 * the production build, which refuses it. It is not needed: React 18 flushes
 * discrete events like clicks synchronously, so yielding once to the macrotask
 * queue is enough for the DOM to reflect the update.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const container = dom.window.document.getElementById('root');
mount(container, users.find((u) => u.role === 'manager'));
await settle();

let fails = 0;
const ok = (label, detail) => console.log(`  ✓ ${label.padEnd(56)} ${detail ?? ''}`);
const bad = (label, detail) => { fails += 1; console.error(`  ✗ ${label.padEnd(56)} ${detail ?? ''}`); };
const expect = (label, condition, detail) => (condition ? ok(label, detail) : bad(label, detail));

const $ = (selector) => dom.window.document.querySelector(selector);
const alertsButton = () => $('button[aria-label^="Alerts"]');
const accountButton = () =>
  [...dom.window.document.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => b !== alertsButton());

const isOpen = (button) => button?.getAttribute('aria-expanded') === 'true';
const backdrops = () => dom.window.document.querySelectorAll('div[aria-hidden="true"].fixed.inset-0');

/**
 * Stacking, read from the class names.
 *
 * jsdom loads no stylesheet, so `getComputedStyle` reports `position: static`
 * and `z-index: auto` for everything. An earlier version of this file hit-tested
 * with those values and was therefore unable to detect any overlap at all — it
 * passed just as happily with the bug reintroduced, which is the only reason
 * that was caught. The classes are the only description of stacking that exists
 * here, so the classes are what get read.
 */
const zIndexOf = (element) => {
  for (let node = element; node && node.getAttribute; node = node.parentElement) {
    const classes = node.getAttribute('class') || '';
    const z = classes.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
    // A z-index applies only to a positioned element; on a static one the
    // browser ignores it, and so does this.
    const positioned = /(?:^|\s)(relative|absolute|fixed|sticky)(?:\s|$)/.test(classes);
    if (z && positioned) return Number(z[1]);
  }
  return 0; // auto
};

/**
 * A click as the browser delivers it: to whatever is actually on top, not to
 * the element we happen to hold a reference to. That distinction is the whole
 * subject of this file — `button.click()` dispatches straight to the button and
 * steps right over the bug.
 */
const clickAt = async (element) => {
  const covering = [...backdrops()].find((b) => zIndexOf(b) > zIndexOf(element));
  const target = covering ?? element;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  return target !== element;
};

/**
 * Does this element form a stacking context that traps its children?
 *
 * `backdrop-filter` does, and that is the trap this app keeps falling into: the
 * dropdowns' `z-40` applies only *inside* the blurred header, so it cannot lift
 * them above page content that is also blurred and comes later in the document.
 * Raising the dropdown's own z-index can never fix that — only the blurred
 * ancestor's z-index decides where the whole subtree lands.
 */
// The design-system classes that blur do so from index.css, not from a utility
// in the markup, so matching `backdrop-blur` alone would miss every card on the
// page — which is most of what actually covered the menu.
const BLURRED_COMPONENT_CLASSES = ['lh-page-hero', 'lh-card', 'lh-card-pad', 'lh-metric', 'lh-status-strip'];

const isStackingContext = (element) => {
  const classes = element?.getAttribute?.('class') || '';
  if (/(?:^|\s)backdrop-blur(?:-\[?[\w.]+\]?)?(?:\s|$)/.test(classes)) return true;
  return BLURRED_COMPONENT_CLASSES.some((name) =>
    new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(classes),
  );
};

console.log('\nLayering\n');

const header = $('header');
const headerZ = zIndexOf(header);

expect('the header exists', Boolean(header));
expect(
  'the header blurs, so it traps its dropdowns',
  isStackingContext(header),
  'which is exactly why it needs a z-index of its own',
);
expect(
  'the header carries its own z-index',
  headerZ > 0,
  headerZ > 0 ? `z-${headerZ}` : 'none — its menus render behind the page',
);
expect('the header outranks page content', headerZ > 0, `header z-${headerZ} vs content 0`);
expect('the header stays below the modal layer', headerZ < 50, `${headerZ} < 50`);

{
  // Every blurred element in the page body makes its own stacking context and
  // sits later in the document, so any tie at the same level goes to content.
  const blurredContent = [...dom.window.document.querySelectorAll('main *')]
    .filter((el) => isStackingContext(el) && el !== header && !header.contains(el));
  expect(
    'blurred page content stays below the header',
    blurredContent.every((el) => zIndexOf(el) < headerZ),
    `${blurredContent.length} blurred element(s) checked`,
  );
}

console.log('\nHeader menus\n');

expect('both triggers exist', Boolean(alertsButton() && accountButton()));
expect('nothing is open initially', !isOpen(alertsButton()) && !isOpen(accountButton()));
expect('no backdrop until a menu opens', backdrops().length === 0);

await clickAt(accountButton());
expect('the account menu opens', isOpen(accountButton()));
expect('exactly one backdrop is mounted', backdrops().length === 1, `${backdrops().length}`);

// The regression. Before the fix this click landed on the backdrop.
const swallowed = await clickAt(alertsButton());
expect('the alerts trigger is not covered by the backdrop', !swallowed, swallowed ? 'click was intercepted' : 'reached the button');
expect('alerts open in ONE click from the account menu', isOpen(alertsButton()));
expect('the account menu closed as alerts opened', !isOpen(accountButton()));
expect('still exactly one backdrop', backdrops().length === 1, `${backdrops().length}`);

// ...and back the other way.
const swallowedBack = await clickAt(accountButton());
expect('the account trigger is not covered either', !swallowedBack, swallowedBack ? 'click was intercepted' : 'reached the button');
expect('the account menu opens in ONE click from alerts', isOpen(accountButton()));
expect('alerts closed', !isOpen(alertsButton()));

// Clicking the open trigger closes it.
await clickAt(accountButton());
expect('clicking the open trigger closes it', !isOpen(accountButton()));
expect('the backdrop is removed on close', backdrops().length === 0);

// Escape.
await clickAt(accountButton());
dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
await settle();
expect('Escape closes the open menu', !isOpen(accountButton()));

// The outside click the backdrop is actually for.
await clickAt(accountButton());
backdrops()[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await settle();
expect('clicking outside closes the menu', !isOpen(accountButton()));

rmSync(work, { recursive: true, force: true });

if (fails > 0) {
  console.error(`\n✗ ${fails} header menu check(s) failed\n`);
  process.exit(1);
}
console.log('\n✓ header menus behave\n');
