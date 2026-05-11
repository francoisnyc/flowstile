/**
 * Helper script to check workflow status.
 * Called from e2e tests via child_process.
 * Expects workflow ID as argv[2], outputs JSON status to stdout.
 */
import { Connection, Client } from '@temporalio/client';

const workflowId = process.argv[2];

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  console.log(JSON.stringify({ status: desc.status.name }));
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
