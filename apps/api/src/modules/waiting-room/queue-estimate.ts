/**
 * Expected wait of the person at `position` (1 = admitted next): the time
 * left until the sale opens, then one tick per `admitPerTick` people up to
 * and including them. An estimate: people who never come back still take
 * their turn, so the line moves at exactly this pace.
 */
export function estimateWaitMs(
  position: number,
  msUntilOpen: number,
  admitPerTick: number,
  tickMs: number,
): number {
  return Math.max(msUntilOpen, 0) + Math.ceil(position / admitPerTick) * tickMs;
}

/**
 * When a client without the WebSocket should ask again: a quarter of the
 * expected wait, between 1 and 30 seconds. Someone 2,000th in line asks
 * every few seconds instead of every second; polling every 2 s by 2,000
 * buyers saturated the API in the on-sale run (phase 7b).
 */
export function pollAfterMs(waitMs: number): number {
  return Math.min(Math.max(Math.round(waitMs / 4), 1000), 30_000);
}
