export interface PaymentInput {
  orderId: string;
  amount: number;
  customerEmail: string;
}

export interface PaymentResult {
  transactionId: string;
  amount: number;
  status: 'charged';
}

export interface RefundResult {
  status: 'refunded';
}

export interface CancelShipmentResult {
  status: 'cancelled';
}

export async function processPayment(input: PaymentInput): Promise<PaymentResult> {
  // Simulated payment — always succeeds with artificial delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  const transactionId = `TXN-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[Payment] Charged $${input.amount} for order ${input.orderId} → ${transactionId}`);
  return { transactionId, amount: input.amount, status: 'charged' };
}

export async function refundPayment(orderId: string): Promise<RefundResult> {
  // Compensation: idempotent refund
  console.log(`[Payment] Refunded order ${orderId}`);
  return { status: 'refunded' };
}

export async function cancelShipment(orderId: string): Promise<CancelShipmentResult> {
  // Compensation: no-op in demo (shipment never dispatched)
  console.log(`[Shipment] Cancelled shipment for order ${orderId}`);
  return { status: 'cancelled' };
}
