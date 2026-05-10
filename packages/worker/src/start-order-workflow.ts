import 'dotenv/config';
import { Connection, Client } from '@temporalio/client';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';
const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';

async function main() {
  // Authenticate with Flowstile server
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

  // Find the Order Fulfillment process and its task definitions
  const processRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!processRes.ok) throw new Error(`Failed to fetch processes: ${processRes.status}`);
  const processes = (await processRes.json()) as { items: { id: string; name: string }[] };
  const orderProcess = processes.items.find((p) => p.name === 'Order Fulfillment');
  if (!orderProcess) throw new Error('Order Fulfillment process not found — run db:seed first');

  const taskDefsRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes/${orderProcess.id}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!taskDefsRes.ok) throw new Error(`Failed to fetch task definitions: ${taskDefsRes.status}`);
  const taskDefs = (await taskDefsRes.json()) as { items: { id: string; code: string }[] };

  const approveOrder = taskDefs.items.find((td) => td.code === 'APPROVE_ORDER');
  const confirmShipment = taskDefs.items.find((td) => td.code === 'CONFIRM_SHIPMENT');
  const handleException = taskDefs.items.find((td) => td.code === 'HANDLE_EXCEPTION');

  if (!approveOrder || !confirmShipment || !handleException) {
    throw new Error('Missing task definitions — run db:seed first');
  }

  console.log('Found task definitions:');
  console.log(`  APPROVE_ORDER:     ${approveOrder.id}`);
  console.log(`  CONFIRM_SHIPMENT:  ${confirmShipment.id}`);
  console.log(`  HANDLE_EXCEPTION:  ${handleException.id}`);

  // Start the workflow
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const orderId = `ORD-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

  const handle = await client.workflow.start('orderFulfillmentWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `order-fulfillment-${orderId}`,
    args: [{
      orderId,
      customerName: 'Alex Thompson',
      customerEmail: 'alex.t@example.com',
      shippingAddress: '742 Evergreen Terrace, Springfield, IL 62704',
      items: [
        { name: 'Mechanical Keyboard', quantity: 1, price: 149.99 },
        { name: 'Monitor Arm', quantity: 1, price: 89.99 },
        { name: 'Webcam', quantity: 1, price: 69.99 },
      ],
      total: 309.97,
      approveOrderTaskDefId: approveOrder.id,
      confirmShipmentTaskDefId: confirmShipment.id,
      handleExceptionTaskDefId: handleException.id,
    }],
  });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ORDER FULFILLMENT WORKFLOW STARTED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Workflow ID:  ${handle.workflowId}`);
  console.log(`  Order ID:     ${orderId}`);
  console.log(`  Customer:     Alex Thompson`);
  console.log(`  Total:        $309.97`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  DEMO STEPS:`);
  console.log(`  1. Login as alice@example.com / password`);
  console.log(`     → Approve the order (or reject to exit early)`);
  console.log(`  2. Login as bob@example.com / password`);
  console.log(`     → Confirm shipment with tracking number`);
  console.log(`     → OR reject to trigger saga compensation`);
  console.log(`  3. (If rejected) Login as carol@example.com / password`);
  console.log(`     → Handle the customer exception`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log('Waiting for workflow to complete...\n');

  const result = await handle.result();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  WORKFLOW COMPLETED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Result:`, JSON.stringify(result, null, 2));
  console.log(`${'═'.repeat(60)}\n`);

  await connection.close();
}

main().catch((err) => {
  console.error('Failed to start workflow:', err);
  process.exit(1);
});
