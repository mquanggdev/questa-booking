import type { Schemas } from '@/lib/api/client';

export type SeatMap = Schemas['SeatMapResponseDto'];

/** One realtime batch (WebSocket /seats, event `seats.batch`). */
export interface SeatsBatch {
  performanceId: string;
  seq: number;
  seats: { id: string; status: string }[];
  zones: { id: string; available: number }[];
}

export interface SyncResult {
  /** The map with every applicable batch applied (same object if none). */
  map: SeatMap;
  /** Batches kept for later: none unless a gap was found. */
  pending: SeatsBatch[];
  /** A batch is missing: drop `pending` and fetch a fresh snapshot. */
  reload: boolean;
}

/**
 * Applies realtime batches to a snapshot, following the seq rule (spec,
 * "Sơ đồ ghế realtime"):
 * - a batch with seq <= map.seq is already in the snapshot: skip it;
 * - batches are applied strictly in order, seq + 1 each time;
 * - a hole in the sequence means a batch was missed (reconnect, or a
 *   failed publish): the client must reload the snapshot.
 * Batches carry the CURRENT state of what changed, so applying one twice,
 * or after a snapshot that already had it, is harmless.
 */
export function applyBatches(map: SeatMap, batches: SeatsBatch[]): SyncResult {
  const queue = batches
    .filter((b) => b.performanceId === map.performanceId && b.seq > map.seq)
    .sort((a, b) => a.seq - b.seq);
  if (queue.length === 0) return { map, pending: [], reload: false };
  if (queue[0].seq !== map.seq + 1)
    return { map, pending: queue, reload: true };

  const seats = new Map(map.seats.map((s) => [s.id, s]));
  const zones = new Map(map.zones.map((z) => [z.id, z]));
  let seq = map.seq;
  for (const batch of queue) {
    if (batch.seq <= seq) continue; // the same batch delivered twice
    if (batch.seq !== seq + 1) {
      return {
        map: rebuild(map, seats, zones, seq),
        pending: [],
        reload: true,
      };
    }
    for (const change of batch.seats) {
      const seat = seats.get(change.id);
      if (seat)
        seats.set(change.id, {
          ...seat,
          status: change.status as typeof seat.status,
        });
    }
    for (const change of batch.zones) {
      const zone = zones.get(change.id);
      if (zone) zones.set(change.id, { ...zone, available: change.available });
    }
    seq = batch.seq;
  }
  return { map: rebuild(map, seats, zones, seq), pending: [], reload: false };
}

function rebuild(
  map: SeatMap,
  seats: Map<string, SeatMap['seats'][number]>,
  zones: Map<string, SeatMap['zones'][number]>,
  seq: number,
): SeatMap {
  return {
    ...map,
    seq,
    // Keep the original order (the canvas lays seats out by row and number).
    seats: map.seats.map((s) => seats.get(s.id) ?? s),
    zones: map.zones.map((z) => zones.get(z.id) ?? z),
  };
}
