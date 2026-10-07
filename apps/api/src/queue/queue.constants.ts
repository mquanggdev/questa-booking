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
