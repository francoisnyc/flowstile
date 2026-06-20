import 'dotenv/config';
import { createFlowstileWorker } from '@flowstile/sdk/worker';
import { orderFulfillmentProcess } from './order-fulfillment/process.js';
import { loanOriginationProcess } from './loan-origination/process.js';
import { expenseApprovalProcess } from './expense-approval/process.js';
import { vacationLeaveRequestProcess } from './vacation-leave/process.js';
import { purchaseRequisitionApprovalProcess } from './purchase-requisition/process.js';
import { processPayment, refundPayment, cancelShipment } from './order-fulfillment/activities.js';
import { fetchCreditScore } from './loan-origination/activities.js';
import { recordReimbursement } from './expense-approval/activities.js';
import { recordLeaveLedger } from './vacation-leave/activities.js';
import { issuePurchaseOrder } from './purchase-requisition/activities.js';

// In production the worker must authenticate with a real service API key; the
// dev fallback only works against a seeded dev database. Fail fast otherwise.
const apiKey =
  process.env.FLOWSTILE_API_KEY ??
  (process.env.NODE_ENV === 'production' ? undefined : 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD');
if (!apiKey) {
  throw new Error('FLOWSTILE_API_KEY must be set in production');
}

createFlowstileWorker({
  process: [orderFulfillmentProcess, loanOriginationProcess, expenseApprovalProcess, vacationLeaveRequestProcess, purchaseRequisitionApprovalProcess],
  flowstile: {
    baseUrl: process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000',
    apiKey,
  },
  temporal: { address: process.env.TEMPORAL_ADDRESS },
  workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
  activities: { processPayment, refundPayment, cancelShipment, fetchCreditScore, recordReimbursement, recordLeaveLedger, issuePurchaseOrder },
}).catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
