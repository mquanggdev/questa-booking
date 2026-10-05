import { createHash } from 'node:crypto';

export interface StandingSelection {
  zoneId: string;
  quantity: number;
}

export interface NormalizedSelection {
  performanceId: string;
  seatIds: string[];
  standing: StandingSelection[];
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

/**
 * Canonical form of a reservation request: seat ids sorted, standing entries
 * for the same zone merged and sorted. Two requests that mean the same thing
 * normalize to the same value, whatever order the client listed them in.
 */
export function normalizeSelection(input: {
  performanceId: string;
  seatIds?: string[];
  standing?: StandingSelection[];
}): NormalizedSelection {
  const totals = new Map<string, number>();
  for (const s of input.standing ?? []) {
    totals.set(s.zoneId, (totals.get(s.zoneId) ?? 0) + s.quantity);
  }
  return {
    performanceId: input.performanceId,
    seatIds: [...(input.seatIds ?? [])].sort(),
    standing: [...totals]
      .map(([zoneId, quantity]) => ({ zoneId, quantity }))
      .sort((a, b) => a.zoneId.localeCompare(b.zoneId)),
  };
}

/** Fingerprint stored with the order, to detect a key reused for another request. */
export function requestHash(selection: NormalizedSelection): string {
  return createHash('sha256').update(JSON.stringify(selection)).digest('hex');
}

export function ticketCount(selection: NormalizedSelection): number {
  return (
    selection.seatIds.length +
    selection.standing.reduce((sum, s) => sum + s.quantity, 0)
  );
}
