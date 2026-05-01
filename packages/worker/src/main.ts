import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as allActivities from './activities.js';

const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const FLOWSTILE_EMAIL = process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local';
const FLOWSTILE_PASSWORD = process.env.FLOWSTILE_PASSWORD ?? 'password';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';

async function run() {
  // Configure the REST client used by all Flowstile activities
  const { configureFlowstileActivities, ...activities } = allActivities;
  configureFlowstileActivities({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  });

  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    // Temporal bundles this file's exports for the deterministic workflow sandbox
    workflowsPath: new URL('./workflows.js', import.meta.url).href,
    activities,
  });

  console.log(
    `Flowstile worker started — task queue: ${TASK_QUEUE}, Temporal: ${TEMPORAL_ADDRESS}`,
  );
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
