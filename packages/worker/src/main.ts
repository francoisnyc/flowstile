import 'dotenv/config';
import { createFlowstileWorker } from '@flowstile/sdk/worker';
import { orderFulfillmentProcess } from './order-fulfillment/process.js';
import { processPayment, refundPayment, cancelShipment } from './order-fulfillment/activities.js';

createFlowstileWorker({
  process: orderFulfillmentProcess,
  flowstile: {
    baseUrl: process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000',
    apiKey: process.env.FLOWSTILE_API_KEY ?? 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD',
  },
  temporal: { address: process.env.TEMPORAL_ADDRESS },
  workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
  activities: { processPayment, refundPayment, cancelShipment },
}).catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
