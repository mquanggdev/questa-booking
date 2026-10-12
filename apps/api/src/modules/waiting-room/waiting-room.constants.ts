// Shared by the gateway (API replicas) and the admitter (worker), which
// never talk directly: the admitter publishes through Redis and every
// replica's Socket.IO Redis adapter delivers to its own sockets.
export const QUEUE_NAMESPACE = '/queue';

export const QueueEvent = {
  /** Client -> server: follow my place in one performance's line. Ack: QueueStatus. */
  JOIN: 'join',
  /** Server -> everyone in a line, every tick. */
  POSITION: 'queue.position',
  /** Server -> one person: you are in, with the pass's expiry. */
  ADMITTED: 'queue.admitted',
} as const;

/** Everyone following one performance's line. */
export const lineRoom = (performanceId: string) => `queue:${performanceId}`;

/** One person in one line. */
export const personRoom = (performanceId: string, userId: string) =>
  `queue:${performanceId}:user:${userId}`;

/**
 * Payload of QueueEvent.POSITION. One message for the whole line, not one
 * per person: everyone knows their own number, and their position is
 * `number - admittedThrough` (1 = next). The line is first come first
 * served and nobody leaves it except by being admitted, so this is exact.
 */
export interface QueuePositionEvent {
  performanceId: string;
  /** Number of the last person admitted (0 = nobody yet). */
  admittedThrough: number;
  /** People still waiting. */
  waiting: number;
}

/** Payload of QueueEvent.ADMITTED. */
export interface QueueAdmittedEvent {
  performanceId: string;
  /** ISO time the admission pass stops being accepted. */
  expiresAt: string;
}

// Redis keys. Standalone Redis: the admit script also writes pass keys it
// builds itself, which Redis Cluster would refuse (keys must be declared).
export const WaitingRoomKey = {
  /** Sorted set: user id -> number in line (arrival order). */
  line: (performanceId: string) => `wr:${performanceId}:line`,
  /** Hash: seq (last number given out), served (last number admitted). */
  meta: (performanceId: string) => `wr:${performanceId}:meta`,
  /** Prefix of the admission passes: `${prefix}${userId}`, with a TTL. */
  passPrefix: (performanceId: string) => `wr:${performanceId}:pass:`,
  /** Set of performances with people waiting: what the admitter visits. */
  active: 'wr:active',
} as const;

/** A line nobody joins or leaves for this long is dropped by Redis. */
export const LINE_KEY_TTL_SECONDS = 24 * 60 * 60;
