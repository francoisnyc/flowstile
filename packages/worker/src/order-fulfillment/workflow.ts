import {
  proxyActivities,
  CancellationScope,
  log,
} from '@temporalio/workflow';
import { createTaskAndWait } from '@flowstile/sdk/workflows';
import type * as orderActivities from './activities.js';

const {
  processPayment,
  refundPayment,
  cancelShipment,
} = proxyActivities<typeof orderActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// --- Types ---

export interface OrderInput {
  orderId: string;
  customerName: string;
  customerEmail: string;
  shippingAddress: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  approveOrderTaskDefId: string;
  confirmShipmentTaskDefId: string;
  handleExceptionTaskDefId: string;
}

export type OrderResult =
  | { status: 'shipped'; orderId: string; trackingNumber: string }
  | { status: 'rejected'; orderId: string; reason: string };

interface ApprovalDecision extends Record<string, unknown> {
  DECISION: 'APPROVED' | 'REJECTED';
  REASON: string;
}

interface ShipmentDecision extends Record<string, unknown> {
  DECISION: 'CONFIRMED' | 'REJECTED';
  REASON: string;
  TRACKING_NUMBER: string;
}

interface ExceptionResolution extends Record<string, unknown> {
  RESOLUTION: string;
  NOTES: string;
}

// --- Workflow ---

export async function orderFulfillmentWorkflow(input: OrderInput): Promise<OrderResult> {
  const compensations: Array<() => Promise<void>> = [];

  try {
    // Step 1: Human approval (order-reviewers)
    log.info('Waiting for order approval', { orderId: input.orderId });
    const approval = await createTaskAndWait<ApprovalDecision>({
      taskDefinitionId: input.approveOrderTaskDefId,
      processInstanceId: input.orderId,
      priority: 'high',
      inputData: {
        ORDER_ITEMS: input.items,
        TOTAL: input.total,
        CUSTOMER_EMAIL: input.customerEmail,
      },
      contextData: {
        ORDER_ID: input.orderId,
        CUSTOMER_NAME: input.customerName,
      },
    });

    if (approval.data.DECISION === 'REJECTED') {
      log.info('Order rejected at approval', { orderId: input.orderId, reason: approval.data.REASON });
      return { status: 'rejected', orderId: input.orderId, reason: approval.data.REASON };
    }

    // Step 2: Process payment (automated)
    log.info('Processing payment', { orderId: input.orderId, amount: input.total });
    compensations.push(() => refundPayment(input.orderId).then(() => undefined));
    const payment = await processPayment({
      orderId: input.orderId,
      amount: input.total,
      customerEmail: input.customerEmail,
    });

    // Step 3: Warehouse confirmation (warehouse group)
    log.info('Waiting for shipment confirmation', { orderId: input.orderId });
    compensations.push(() => cancelShipment(input.orderId).then(() => undefined));
    const shipment = await createTaskAndWait<ShipmentDecision>({
      taskDefinitionId: input.confirmShipmentTaskDefId,
      processInstanceId: input.orderId,
      priority: 'normal',
      inputData: {
        ORDER_ITEMS: input.items,
        SHIPPING_ADDRESS: input.shippingAddress,
      },
      contextData: {
        ORDER_ID: input.orderId,
        CUSTOMER_NAME: input.customerName,
        TRANSACTION_ID: payment.transactionId,
      },
    });

    if (shipment.data.DECISION === 'REJECTED') {
      log.info('Order rejected at warehouse — running saga compensation', {
        orderId: input.orderId,
        reason: shipment.data.REASON,
      });

      // Business rejection: compensate and route to customer service
      await CancellationScope.nonCancellable(async () => {
        for (const compensate of compensations.reverse()) {
          try {
            await compensate();
          } catch (e) {
            log.warn('Compensation failed', { error: e });
          }
        }

        // Handle exception (customer-service group)
        await createTaskAndWait<ExceptionResolution>({
          taskDefinitionId: input.handleExceptionTaskDefId,
          processInstanceId: input.orderId,
          priority: 'urgent',
          inputData: {
            REASON: shipment.data.REASON,
            REFUNDED: true,
          },
          contextData: {
            ORDER_ID: input.orderId,
            CUSTOMER_NAME: input.customerName,
            CUSTOMER_EMAIL: input.customerEmail,
          },
        });
      });

      return { status: 'rejected', orderId: input.orderId, reason: shipment.data.REASON };
    }

    log.info('Order fulfilled', { orderId: input.orderId, trackingNumber: shipment.data.TRACKING_NUMBER });
    return { status: 'shipped', orderId: input.orderId, trackingNumber: shipment.data.TRACKING_NUMBER };
  } catch (err) {
    // Unexpected errors: compensate and re-throw
    log.error('Unexpected error in order fulfillment — running compensation', { error: err });
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of compensations.reverse()) {
        try {
          await compensate();
        } catch (e) {
          log.warn('Compensation failed', { error: e });
        }
      }
    });
    throw err;
  }
}
