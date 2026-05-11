/**
 * Helper script to start the order fulfillment workflow.
 * Called from e2e tests via child_process.
 * Expects JSON args on stdin, outputs workflow ID to stdout.
 */
import { Connection, Client } from '@temporalio/client';

const args = JSON.parse(process.argv[2]);

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  const handle = await client.workflow.start('orderFulfillmentWorkflow', {
    taskQueue: 'flowstile',
    workflowId: args.workflowId,
    args: [args.input],
  });

  console.log(JSON.stringify({ workflowId: handle.workflowId }));
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
