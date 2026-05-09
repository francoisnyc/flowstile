import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as allActivities from './activities.js';

const FLOWSTILE_SERVER_URL =
  process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const FLOWSTILE_EMAIL =
  process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local';
const FLOWSTILE_PASSWORD = process.env.FLOWSTILE_PASSWORD ?? 'password';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';

async function run() {
  // --- Step 1: Verify Flowstile server is reachable ---
  try {
    const resp = await fetch(`${FLOWSTILE_SERVER_URL}/health`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.error(
      `\nFailed to reach Flowstile server at ${FLOWSTILE_SERVER_URL}` +
        `\nIs the server running? Try: pnpm --filter @flowstile/server dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  // --- Step 2: Configure Flowstile activities ---
  const { configureFlowstileActivities, ...activities } = allActivities;
  configureFlowstileActivities({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  });

  // --- Step 3: Connect to Temporal ---
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  } catch (err) {
    console.error(
      `\nFailed to connect to Temporal at ${TEMPORAL_ADDRESS}` +
        `\nIs the Temporal server running? Try: temporal server start-dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  // --- Step 4: Create and run worker ---
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
    activities,
  });

  console.log(
    `\nFlowstile worker started` +
      `\n  Temporal:  ${TEMPORAL_ADDRESS}` +
      `\n  Server:    ${FLOWSTILE_SERVER_URL}` +
      `\n  Auth:      ${FLOWSTILE_EMAIL}` +
      `\n  Queue:     ${TASK_QUEUE}` +
      `\n  Workflows: ./workflows.ts\n`,
  );

  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
