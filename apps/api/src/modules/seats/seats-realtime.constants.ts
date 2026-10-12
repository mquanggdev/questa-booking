// Shared by the gateway (API replicas) and the flusher (worker), which never
// talk directly: the flusher publishes through Redis and every replica's
// Socket.IO Redis adapter delivers to its own sockets.
export const SEATS_NAMESPACE = '/seats';

export const SeatsEvent = {
  /** Client -> server: watch one performance. Ack: { instance, seq }. */
  JOIN: 'join',
  /** Server -> client: a batch of changes with its seq. */
  BATCH: 'seats.batch',
} as const;

export const performanceRoom = (performanceId: string) =>
  `performance:${performanceId}`;

/** Payload of SeatsEvent.BATCH. */
export interface SeatsBatch {
  performanceId: string;
  /** Strictly increasing per performance, +1 per batch. */
  seq: number;
  /** Current status of every seat that changed. */
  seats: { id: string; status: string }[];
  /** Tickets left in every zone that changed (seated and standing). */
  zones: { id: string; available: number }[];
}
