import 'dotenv/config';
import { Connection, Client } from '@temporalio/client';
import { orderProcess } from './order-fulfillment/process.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

async function main() {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const orderId = `ORD-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

  const handle = await client.workflow.start('orderFulfillmentWorkflow', {
    taskQueue: orderProcess.taskQueue,
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
