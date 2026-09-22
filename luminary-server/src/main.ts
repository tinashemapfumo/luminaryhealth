import { buildApp } from './app.js';
import { config } from './platform/config.js';
import { closePool } from './platform/db.js';
import { assertSchemaReady } from './platform/schema-check.js';
import { startSyncWorker, stopSyncWorker } from './modules/sync/sync.worker.js';
import { configureDispatcher, startDispatcher } from './modules/messaging/messaging.dispatcher.js';
import { startFollowupReconciler } from './modules/agent/followup.worker.js';
import { startPatientExportWorker } from './modules/patient-exports/patient-exports.worker.js';

const app = buildApp();
let stopMessagingDispatcher: (() => void) | null = null;
let stopFollowupReconciler: (() => void) | null = null;
let stopPatientExportWorker: (() => void) | null = null;

async function start(): Promise<void> {
  try {
    await assertSchemaReady();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`luminary-server listening on ${config.port} as node "${config.nodeId}"`);
    // Only a local node initiates replication; cloud answers.
    startSyncWorker(app.log);
    stopPatientExportWorker = startPatientExportWorker((result) =>
      app.log.info({ result }, 'patient_export_cycle'),
    (error) => app.log.error({ error }, 'patient_export_worker_failed'));
    configureDispatcher(config.messagingDispatchEnabled);
    if (config.messagingDispatchEnabled) {
      stopFollowupReconciler = startFollowupReconciler((result) =>
        app.log.info({ result }, 'followup_reconciliation_cycle'),
      (error) => app.log.error({ error }, 'followup_reconciliation_failed'));
      stopMessagingDispatcher = startDispatcher(config.messagingDispatchIntervalMs, (result) =>
        app.log.info({ result }, 'messaging_dispatcher_cycle'));
      app.log.info({ intervalMs: config.messagingDispatchIntervalMs }, 'messaging_dispatcher_started');
    } else {
      app.log.info('messaging_dispatcher_disabled');
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

/**
 * Shut down cleanly. On a clinic's local server this process will be stopped by
 * a power cut as often as by a deploy, so in-flight transactions must not be
 * left holding connections when it is stopped politely.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    stopMessagingDispatcher?.();
    stopFollowupReconciler?.();
    stopPatientExportWorker?.();
    stopSyncWorker();
    void app.close().then(closePool).then(() => process.exit(0));
  });
}

void start();
