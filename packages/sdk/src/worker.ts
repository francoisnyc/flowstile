import { Worker, NativeConnection } from '@temporalio/worker';
import {
  configureFlowstileActivities,
  createFlowstileTask,
  getFlowstileTask,
  cancelFlowstileTask,
  getFlowstileCaseEntity,
  patchFlowstileCaseEntity,
  setFlowstileCaseEntity,
  setFlowstileCaseVariables,
} from './activities.js';
import type { FlowstileClientOptions } from './types.js';
import type { ProcessDefinition } from './process.js';

// The built-in activities that every Flowstile workflow relies on. The
// `createTaskAndWait` helper proxies `createFlowstileTask`/`cancelFlowstileTask`,
// and case-entity helpers proxy the rest. These must be registered on the worker
// alongside any caller-supplied activities, otherwise Temporal reports
// "Activity function ... is not registered on this Worker".
const FLOWSTILE_ACTIVITIES = {
  createFlowstileTask,
  getFlowstileTask,
  cancelFlowstileTask,
  getFlowstileCaseEntity,
  patchFlowstileCaseEntity,
  setFlowstileCaseEntity,
  setFlowstileCaseVariables,
};

export interface FlowstileWorkerConfig {
  /** Process definition created with `defineProcess`. Provides the task queue name. */
  process: ProcessDefinition;
  /** Flowstile server connection options (baseUrl + apiKey or auth). */
  flowstile: FlowstileClientOptions;
  /** Temporal connection options. Defaults to localhost:7233. */
  temporal?: { address?: string };
  /**
   * Absolute path to the workflows module.
   * Typically: `new URL('./workflows.js', import.meta.url).pathname`
   */
  workflowsPath: string;
  /** Additional activities to register alongside the built-in Flowstile ones. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activities?: Record<string, (...args: any[]) => any>;
}

/**
 * Creates and runs a Flowstile Temporal worker.
 * Handles the health check, activity configuration, Temporal connection, and startup logging.
 * The promise resolves only when the worker shuts down.
 *
 * Example:
 *   await createFlowstileWorker({
 *     process: myProcess,
 *     flowstile: { baseUrl: process.env.FLOWSTILE_URL!, apiKey: process.env.FLOWSTILE_API_KEY },
 *     temporal: { address: process.env.TEMPORAL_ADDRESS },
 *     workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
 *     activities: { myCustomActivity },
 *   });
 */
export async function createFlowstileWorker(config: FlowstileWorkerConfig): Promise<void> {
  const { process: proc, flowstile, temporal = {}, workflowsPath, activities = {} } = config;
  const temporalAddress = temporal.address ?? 'localhost:7233';

  // Health check — fail fast with a helpful message if the server is unreachable
  try {
    const resp = await fetch(`${flowstile.baseUrl}/health`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.error(
      `\nFailed to reach Flowstile server at ${flowstile.baseUrl}` +
        `\nIs the server running? Try: pnpm --filter @flowstile/server dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  configureFlowstileActivities(flowstile);

  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: temporalAddress });
  } catch (err) {
    console.error(
      `\nFailed to connect to Temporal at ${temporalAddress}` +
        `\nIs the Temporal server running? Try: temporal server start-dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  const worker = await Worker.create({
    connection,
    taskQueue: proc.taskQueue,
    workflowsPath,
    // Register the built-in Flowstile activities first, then let caller-supplied
    // activities extend (or override) them.
    activities: { ...FLOWSTILE_ACTIVITIES, ...activities },
  });

  const authDesc = flowstile.apiKey
    ? `api key ${flowstile.apiKey.slice(0, 12)}…`
    : flowstile.auth?.email ?? '(no auth)';

  console.log(
    `\nFlowstile worker started` +
      `\n  Process:   ${proc.name}` +
      `\n  Temporal:  ${temporalAddress}` +
      `\n  Server:    ${flowstile.baseUrl}` +
      `\n  Auth:      ${authDesc}` +
      `\n  Queue:     ${proc.taskQueue}\n`,
  );

  await worker.run();
}
