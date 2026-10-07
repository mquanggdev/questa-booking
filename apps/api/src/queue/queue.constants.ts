// BullMQ queues and job names. Names are part of the data stored in Redis:
// renaming one strands the jobs already queued under the old name.
export const RESERVATIONS_QUEUE = 'reservations';

export const ReservationJob = {
  /** Delayed per order: release it if still unpaid at expires_at + grace. */
  EXPIRE_ORDER: 'expire-order',
  /** Repeating safety net: release overdue orders whose job was lost. */
  SWEEP_EXPIRED: 'sweep-expired',
  /** Repeating: repair Redis standing counters that drifted from PostgreSQL. */
  RECONCILE_STANDING: 'reconcile-standing',
} as const;

export interface ExpireOrderData {
  orderId: string;
}

/** BullMQ job ids must not contain ":". UUIDs only use "-". */
export const expireJobId = (orderId: string) => `expire-${orderId}`;

export const PAYMENTS_QUEUE = 'payments';
/** Refunds that failed every attempt; kept for a human to look at. */
export const PAYMENTS_DEAD_LETTER_QUEUE = 'payments-dead-letter';

export const PaymentJob = {
  /** Ask the gateway for one refund; retried with exponential backoff. */
  REFUND: 'refund',
  /** Cancel every order of a cancelled performance, in batches. */
  CANCEL_PERFORMANCE: 'cancel-performance',
  /**
   * Repeating safety net: enqueue refunds whose job was lost and resume
   * performance cancellations that did not finish.
   */
  SWEEP: 'sweep-payments',
} as const;

export interface RefundJobData {
  refundId: string;
}

export interface CancelPerformanceData {
  performanceId: string;
}

export const refundJobId = (refundId: string) => `refund-${refundId}`;
export const cancelPerformanceJobId = (performanceId: string) =>
  `cancel-${performanceId}`;
