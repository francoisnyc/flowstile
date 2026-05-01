import 'dotenv/config';
import { Connection, Client } from '@temporalio/client';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';
const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';

async function main() {
  // Look up the REVIEW_LOAN task definition ID from the Flowstile server
  const loginRes = await fetch(`${FLOWSTILE_SERVER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local',
      password: process.env.FLOWSTILE_PASSWORD ?? 'password',
    }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);

  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/flowstile_token=([^;]+)/);
  if (!tokenMatch) throw new Error('No token in login response');
  const token = tokenMatch[1];

  // Find the REVIEW_LOAN task definition
  const processRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!processRes.ok) throw new Error(`Failed to fetch processes: ${processRes.status}`);
  const processes = (await processRes.json()) as { items: { id: string; name: string }[] };
  const loanProcess = processes.items.find((p) => p.name === 'Loan Processing');
  if (!loanProcess) throw new Error('Loan Processing process not found — run db:seed first');

  const taskDefsRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes/${loanProcess.id}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!taskDefsRes.ok) throw new Error(`Failed to fetch task definitions: ${taskDefsRes.status}`);
  const taskDefs = (await taskDefsRes.json()) as { items: { id: string; code: string }[] };
  const reviewLoan = taskDefs.items.find((td) => td.code === 'REVIEW_LOAN');
  if (!reviewLoan) throw new Error('REVIEW_LOAN task definition not found — run db:seed first');

  console.log(`Found REVIEW_LOAN task definition: ${reviewLoan.id}`);

  // Start the workflow
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const processInstanceId = `LN-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

  const handle = await client.workflow.start('loanApprovalWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `loan-approval-${processInstanceId}`,
    args: [{
      taskDefinitionId: reviewLoan.id,
      customerName: 'John Doe',
      amount: 50000,
      processInstanceId,
    }],
  });

  console.log(`\nWorkflow started!`);
  console.log(`  Workflow ID: ${handle.workflowId}`);
  console.log(`  Process Instance: ${processInstanceId}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open http://localhost:5173 and login as alice@example.com / password`);
  console.log(`  2. Find the task for ${processInstanceId} in the inbox`);
  console.log(`  3. Claim it, fill in the form, click Complete`);
  console.log(`  4. Watch the worker terminal — it will log the workflow result`);
  console.log(`\nWaiting for workflow to complete...`);

  const result = await handle.result();
  console.log(`\nWorkflow completed!`);
  console.log(`  Result:`, JSON.stringify(result, null, 2));

  await connection.close();
}

main().catch((err) => {
  console.error('Failed to start workflow:', err);
  process.exit(1);
});
