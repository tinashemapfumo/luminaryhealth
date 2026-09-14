/**
 * Folds the standalone build into one self-contained HTML file.
 *
 * Produces `Luminary-Health.html` at the project root: no server, no install,
 * no sibling files. Double-click and it runs.
 *
 * The only external reference left is the Google Fonts stylesheet for Inter.
 * That is intentional — it upgrades the typography when online and falls back
 * to the system stack when not, rather than bloating the file with font binaries.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'dist-standalone');
const outFile = join(root, 'Luminary-Health.html');

const fail = (message) => {
  console.error(`\n  Standalone build failed: ${message}\n`);
  process.exit(1);
};

if (!existsSync(buildDir)) fail('dist-standalone/ not found — run the vite build first.');

const js = existsSync(join(buildDir, 'app.js')) ? readFileSync(join(buildDir, 'app.js'), 'utf8') : fail('app.js missing');
const css = existsSync(join(buildDir, 'app.css')) ? readFileSync(join(buildDir, 'app.css'), 'utf8') : '';

// Inline the favicon so the tab icon survives without a sibling file.
let favicon = '';
const faviconPath = join(root, 'public', 'favicon.svg');
if (existsSync(faviconPath)) {
  const svg = readFileSync(faviconPath, 'utf8');
  favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" />`;
}

// `</script>` inside the bundle would close the tag early.
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#0a1220" />
<meta name="description" content="Luminary Health — intelligent care operations platform for modern healthcare practices." />
<title>Luminary Health — Care Operations Platform</title>
${favicon}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
</body>
</html>
`;

writeFileSync(outFile, html, 'utf8');
rmSync(buildDir, { recursive: true, force: true });

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);

console.log(`\n  Luminary-Health.html written — ${kb} KB, fully self-contained.`);
console.log(`  External references: ${externals.length === 0 ? 'none' : externals.join(', ')}`);
console.log('  Send this one file to any computer and double-click it.\n');
