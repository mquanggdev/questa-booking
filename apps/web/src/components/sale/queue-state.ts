import type { Schemas } from '@/lib/api/client';

export type QueueStatus = Schemas['QueueStatusDto'];

/** Payload of `queue.position` on the /queue WebSocket (one per line, per tick). */
export interface QueuePositionEvent {
  performanceId: string;
  admittedThrough: number;
  waiting: number;
}

/**
 * Applies a line-wide position update to my status. The server sends one
 * message to the whole line; my position follows from my own number:
 * position = number - admittedThrough. Older updates (admittedThrough
 * going back) are ignored, and only a WAITING status changes.
 */
export function applyPosition(
  status: QueueStatus | undefined,
  event: QueuePositionEvent,
): QueueStatus | undefined {
  if (status?.status !== 'WAITING' || status.number === undefined) {
    return status;
  }
  if (event.admittedThrough < (status.admittedThrough ?? 0)) return status;
  return {
    ...status,
    admittedThrough: event.admittedThrough,
    waiting: event.waiting,
    position: Math.max(status.number - event.admittedThrough, 1),
  };
}

/** "khoảng 3 phút", "khoảng 40 giây", from the server's estimate. */
export function formatWait(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 60) return `khoảng ${Math.max(seconds, 1)} giây`;
  return `khoảng ${Math.round(seconds / 60)} phút`;
}
