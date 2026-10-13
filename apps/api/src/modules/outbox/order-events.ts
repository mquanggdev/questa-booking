// The events of topic orders.events (spec, "Kafka"). Shared by the writers
// (payments, releases, cancellations, refunds), the relay and the consumers.

export const OrderEventType = {
  PAID: 'order.paid',
  EXPIRED: 'order.expired',
  CANCELLED: 'order.cancelled',
  REFUNDED: 'order.refunded',
} as const;
export type OrderEventType =
  (typeof OrderEventType)[keyof typeof OrderEventType];

export const ORDER_EVENT_VERSION = 1;

export interface OrderEventItem {
  zoneId: string;
  /** Null for a standing ticket. */
  seatId: string | null;
  /** VND, the price the buyer paid for this ticket. */
  price: number;
}

/** Why an order was cancelled. */
export type CancelReason = 'CUSTOMER' | 'PERFORMANCE_CANCELLED';

export interface OrderEventData {
  orderId: string;
  userId: string;
  performanceId: string;
  /** VND. For order.refunded, the amount given back. */
  totalAmount: number;
  items: OrderEventItem[];
  /** order.cancelled only. */
  reason?: CancelReason;
  /**
   * order.cancelled only: the order had been PAID (performance cancelled),
   * so its sale is reversed. False for an unpaid hold that was cancelled.
   */
  wasPaid?: boolean;
}

/** What goes on the wire: the outbox row (id, type, time) around its data. */
export interface OrderEvent {
  eventId: string;
  eventType: OrderEventType;
  /** ISO 8601. */
  occurredAt: string;
  version: number;
  data: OrderEventData;
}

/** Throws unless `value` looks like an OrderEvent (a message from Kafka). */
export function parseOrderEvent(value: string): OrderEvent {
  const event = JSON.parse(value) as Partial<OrderEvent>;
  const known = Object.values(OrderEventType) as string[];
  if (
    typeof event.eventId !== 'string' ||
    typeof event.eventType !== 'string' ||
    !known.includes(event.eventType) ||
    typeof event.data?.orderId !== 'string' ||
    typeof event.data.performanceId !== 'string'
  ) {
    throw new Error('Not an order event');
  }
  return event as OrderEvent;
}
