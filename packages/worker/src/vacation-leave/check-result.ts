// Standalone helper: fetch a workflow's status + result by workflowId.
//
// The e2e spec shells out to this (with cwd: packages/worker, so the
// worker-local @temporalio/client resolves) to assert both that the vacation
// workflow COMPLETED and what typed result it returned. Prints a single JSON
// line: { status, result } (result is null until the workflow finishes).
//
// Usage: tsx check-result.ts <workflowId>

import { Connection, Client } from '@temporalio/client';

async function main() {
  const workflowId = process.argv[2];
  if (!workflowId) {
    console.error('usage: check-result.ts <workflowId>');
    process.exit(1);
  }
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address });
  const client = new Client({ connection });
  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  const status = desc.status.name; // e.g. RUNNING, COMPLETED, FAILED

  let result: unknown = null;
  if (status === 'COMPLETED') {
    result = await handle.result();
  }
  console.log(JSON.stringify({ status, result }));
  await connection.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
