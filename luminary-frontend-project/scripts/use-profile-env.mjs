import fs from 'node:fs';
import path from 'node:path';

const profile = process.argv[2];
if (!profile) {
  console.error('Usage: node scripts/use-profile-env.mjs <local-clean|local-demo|online-clean|online-demo>');
  process.exit(1);
}

const root = process.cwd();
const localEnvPath = path.resolve(root, '.env.local');
const profileEnvPath = path.resolve(root, `.env.${profile}`);
const profileLocalEnvPath = path.resolve(root, `.env.${profile}.local`);
const selectedProfileEnvPath = fs.existsSync(profileLocalEnvPath) ? profileLocalEnvPath : profileEnvPath;

if (!fs.existsSync(selectedProfileEnvPath)) {
  console.error(`Missing frontend environment for profile "${profile}". Create .env.${profile} from .env.${profile}.example first.`);
  process.exit(1);
}

fs.copyFileSync(selectedProfileEnvPath, localEnvPath);
console.log(`Selected frontend profile "${profile}" from ${path.basename(selectedProfileEnvPath)}`);
