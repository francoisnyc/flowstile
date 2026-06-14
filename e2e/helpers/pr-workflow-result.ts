// Prints { status, result } for a Temporal workflow by id, as JSON on stdout.
// Run from packages/worker (the @temporalio/client dep lives there, not hoisted):
//   pnpm exec tsx <repo>/e2e/helpers/pr-workflow-result.ts <workflowId>
//
// Authored for the Purchase Requisition e2e per flowstile-authoring §6 — the
// typed-result read-back pattern is quoted there.
import { Client, Connection } from '@temporalio/client';

async function main() {
  const workflowId = process.argv[2];
  if (!workflowId) {
    console.error('usage: pr-workflow-result.ts <workflowId>');
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address });
  const client = new Client({ connection });

  const handle = client.workflow.getHandle(workflowId);
  const desc = await handle.describe();
  const status = desc.status.name;
  const result = status === 'COMPLETED' ? await handle.result() : null;

  console.log(JSON.stringify({ status, result }));
  await connection.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
