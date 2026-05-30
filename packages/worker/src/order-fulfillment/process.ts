import { defineProcess, defineTask } from '@flowstile/sdk/process';

export interface ApprovalDecision extends Record<string, unknown> {
  DECISION: 'APPROVED' | 'REJECTED';
  REASON: string;
}

export interface ShipmentDecision extends Record<string, unknown> {
  DECISION: 'CONFIRMED' | 'REJECTED';
  REASON: string;
  TRACKING_NUMBER: string;
}

export interface ExceptionResolution extends Record<string, unknown> {
  RESOLUTION: string;
  NOTES: string;
}

export const orderProcess = defineProcess('order-fulfillment', {
  taskQueue: 'flowstile',
  tasks: {
    approveOrder: defineTask<ApprovalDecision>('APPROVE_ORDER', { priority: 'high' }),
    confirmShipment: defineTask<ShipmentDecision>('CONFIRM_SHIPMENT'),
    handleException: defineTask<ExceptionResolution>('HANDLE_EXCEPTION', { priority: 'urgent' }),
  },
});
