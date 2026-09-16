import fs from 'node:fs';
import path from 'node:path';

const modeIndex = process.argv.findIndex((arg) => arg === '--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined;
const modeEnvPaths = mode
  ? [
      path.resolve(process.cwd(), `.env.${mode}`),
      path.resolve(process.cwd(), `.env.${mode}.local`),
    ]
  : [];

if (mode && !modeEnvPaths.some((envPath) => fs.existsSync(envPath))) {
  console.error(`Missing frontend environment for mode "${mode}". Create .env.${mode} from .env.${mode}.example first.`);
  process.exit(1);
}

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
  ...modeEnvPaths,
].filter(Boolean);
const env = { ...process.env };

for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) env[key] = value;
  }
}

const apiUrl = String(env.VITE_API_URL || '').trim();
const localApi = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(apiUrl);

if (!apiUrl) {
  console.error('VITE_API_URL is required. Refusing to build a browser-seeded demo app.');
  process.exit(1);
}

if (localApi && env.LUMINARY_ALLOW_LOCAL_FRONTEND_BUILD !== 'true') {
  console.error('VITE_API_URL points at localhost. Use the public API URL for deploy builds.');
  process.exit(1);
}

console.log(`Verified live frontend API target: ${apiUrl}`);
