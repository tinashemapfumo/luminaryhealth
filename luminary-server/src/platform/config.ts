import { z } from 'zod';

/**
 * Configuration is validated at boot and never read from `process.env` again.
 * A missing database URL should stop the server starting, not surface as a
 * confusing error during someone's first patient lookup.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_SIZE: z.coerce.number().default(10),
  CLIENT_FILE_STORAGE_PATH: z.string().default('./client-files'),

  /**
   * Identifies this deployment: 'cloud', or a practice's local server such as
   * 'harare-central-local'. Stamped onto every row so sync can tell where a
   * change came from and reconcile when two nodes touched the same record.
   */
  NODE_ID: z.string().default('cloud'),

  SESSION_TTL_HOURS: z.coerce.number().default(12),
  /**
   * Browser origins allowed to call this API, comma-separated.
   *
   * Empty means no browser may call it, which is the right default for a node
   * that only ever talks to its peer. A wildcard is deliberately not supported:
   * the API is credentialed, and `*` with credentials is both refused by
   * browsers and wrong in principle.
   */
  WEB_ORIGINS: z.string().default(""),
  /** Peer this node replicates with; unset on a standalone cloud deployment. */
  SYNC_PEER_URL: z.string().optional(),
  SYNC_INTERVAL_SECONDS: z.coerce.number().default(30),
  /** Shared secret for node-to-node replication. Absent means replication is off. */
  SYNC_SECRET: z.string().optional(),
  /**
   * The practice this local node serves.
   *
   * A node is provisioned with two facts — which practice it belongs to and the
   * secret scoped to that practice — and learns everything else from the peer.
   * Without this a freshly installed server has no tenant to ask about and no
   * way to bootstrap, since its own practice row is one of the things it does
   * not yet have. Unset on cloud, which serves many practices and initiates
   * nothing.
   */
  SYNC_PRACTICE_ID: z.string().uuid().optional(),
  /**
   * Outbound messages are dispatched by the practice's local node by default.
   * Cloud may enable this explicitly for a standalone deployment, but should
   * not accidentally compete with a local server for the same messages.
   */
  MESSAGING_DISPATCH: z.enum(['true', 'false']).optional(),
  MESSAGING_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STT_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  CLINICAL_AI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  CLINICAL_AI_MODEL: z.string().default('gpt-5-nano'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid configuration:\n${issues}`);
}

export const config = {
  env: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  dbPoolSize: parsed.data.DB_POOL_SIZE,
  clientFileStoragePath: parsed.data.CLIENT_FILE_STORAGE_PATH,
  nodeId: parsed.data.NODE_ID,
  sessionTtlHours: parsed.data.SESSION_TTL_HOURS,
  webOrigins: parsed.data.WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  syncPeerUrl: parsed.data.SYNC_PEER_URL,
  syncIntervalSeconds: parsed.data.SYNC_INTERVAL_SECONDS,
  syncSecret: parsed.data.SYNC_SECRET,
  syncPracticeId: parsed.data.SYNC_PRACTICE_ID,
  isLocalNode: parsed.data.NODE_ID !== 'cloud',
  messagingDispatchEnabled: parsed.data.MESSAGING_DISPATCH
    ? parsed.data.MESSAGING_DISPATCH === 'true'
    : parsed.data.NODE_ID !== 'cloud',
  messagingDispatchIntervalMs: parsed.data.MESSAGING_DISPATCH_INTERVAL_MS,
  sttProvider: parsed.data.STT_PROVIDER,
  sttApiKey: parsed.data.STT_API_KEY,
  sttModel: parsed.data.STT_MODEL,
  clinicalAiProvider: parsed.data.CLINICAL_AI_PROVIDER,
  clinicalAiModel: parsed.data.CLINICAL_AI_MODEL,
} as const;
