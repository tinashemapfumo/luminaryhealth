const profile = process.argv[2];
const validProfiles = new Set(['local-clean', 'online-clean']);

if (!validProfiles.has(profile)) {
  console.error('Usage: node --env-file=<clean-env> scripts/assert-clean-env.mjs <local-clean|online-clean>');
  process.exit(1);
}

const errors = [];
const value = (name) => String(process.env[name] || '').trim();
const required = (name) => {
  const current = value(name);
  if (!current) errors.push(`${name} is required`);
  return current;
};
const hasPlaceholder = (input) => /(change-me|replace-with|example\.com|change-this|demo-db-host|db-host)/i.test(input);

const nodeEnv = required('NODE_ENV');
const nodeId = required('NODE_ID');
const databaseUrl = required('DATABASE_URL');
const webOrigins = required('WEB_ORIGINS');
const storagePath = required('CLIENT_FILE_STORAGE_PATH');
const showTestPractices = value('SHOW_TEST_PRACTICES') || 'false';
const messagingDispatch = value('MESSAGING_DISPATCH') || 'false';

if (nodeEnv !== 'production') errors.push('NODE_ENV must be production for clean deployments');
if (showTestPractices !== 'false') errors.push('SHOW_TEST_PRACTICES must be false for clean deployments');
if (messagingDispatch !== 'false') errors.push('MESSAGING_DISPATCH must be false unless a real messaging dispatcher has been provisioned');
if (value('LUMINARY_ALLOW_PRODUCTION_TEST_SEED') === 'true') errors.push('LUMINARY_ALLOW_PRODUCTION_TEST_SEED must not be true in clean deployments');
if (value('LUMINARY_TEST_PASSWORD')) errors.push('LUMINARY_TEST_PASSWORD belongs only in demo environments');
if (/demo|test|seed/i.test(databaseUrl)) errors.push('DATABASE_URL must not point at a demo/test/seed database');
if (hasPlaceholder(databaseUrl)) errors.push('DATABASE_URL still contains a placeholder');
if (hasPlaceholder(webOrigins)) errors.push('WEB_ORIGINS still contains a placeholder');

const origins = webOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
if (!origins.length) errors.push('WEB_ORIGINS must contain at least one browser origin');

if (profile === 'online-clean') {
  if (nodeId !== 'cloud') errors.push('NODE_ID should be cloud for online-clean');
  if (/localhost|127\.0\.0\.1|host\.docker\.internal/i.test(databaseUrl)) errors.push('online-clean DATABASE_URL must not point at localhost');
  if (!storagePath.startsWith('/')) errors.push('online-clean CLIENT_FILE_STORAGE_PATH should be an absolute server path');
  for (const origin of origins) {
    if (!origin.startsWith('https://')) errors.push(`online-clean WEB_ORIGINS must use https: ${origin}`);
    if (/localhost|127\.0\.0\.1/i.test(origin)) errors.push(`online-clean WEB_ORIGINS must not include localhost: ${origin}`);
  }
  if (value('STT_PROVIDER') === 'openai' && (!value('STT_API_KEY') || hasPlaceholder(value('STT_API_KEY')))) {
    errors.push('STT_API_KEY is required when STT_PROVIDER=openai');
  }
}

if (profile === 'local-clean') {
  if (nodeId === 'cloud') errors.push('local-clean NODE_ID should identify the clinic/local server, not cloud');
  const localDbPassword = required('LOCAL_POSTGRES_PASSWORD');
  if (hasPlaceholder(localDbPassword)) errors.push('LOCAL_POSTGRES_PASSWORD still contains a placeholder');
  if (value('BOOTSTRAP_ADMIN_EMAIL') && hasPlaceholder(value('BOOTSTRAP_ADMIN_EMAIL'))) {
    errors.push('BOOTSTRAP_ADMIN_EMAIL still contains a placeholder');
  }
  if (value('BOOTSTRAP_ADMIN_PASSWORD') && hasPlaceholder(value('BOOTSTRAP_ADMIN_PASSWORD'))) {
    errors.push('BOOTSTRAP_ADMIN_PASSWORD still contains a placeholder');
  }
}

if (errors.length) {
  console.error(`Clean environment check failed for ${profile}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Clean environment check passed for ${profile}`);
