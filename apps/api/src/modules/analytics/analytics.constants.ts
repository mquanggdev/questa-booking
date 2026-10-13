// The organizer's live sales dashboard (spec, WebSocket `/sales`).
export const SALES_NAMESPACE = '/sales';

export const SalesEvent = {
  /** Client -> server: follow one performance (its organizer only). Ack: SalesStatsDto. */
  JOIN: 'join',
  /** Server -> client: the new SalesStatsDto after a sale or a reversal. */
  UPDATED: 'sales.updated',
} as const;

export const salesRoom = (performanceId: string) => `sales:${performanceId}`;
