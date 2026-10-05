import {
  isValidIdempotencyKey,
  normalizeSelection,
  requestHash,
  ticketCount,
} from './reservation-request.js';

describe('reservation request helpers', () => {
  it('normalizes order and merges standing entries of one zone', () => {
    const a = normalizeSelection({
      performanceId: 'p',
      seatIds: ['s2', 's1'],
      standing: [
        { zoneId: 'z2', quantity: 1 },
        { zoneId: 'z1', quantity: 1 },
        { zoneId: 'z2', quantity: 2 },
      ],
    });
    expect(a).toEqual({
      performanceId: 'p',
      seatIds: ['s1', 's2'],
      standing: [
        { zoneId: 'z1', quantity: 1 },
        { zoneId: 'z2', quantity: 3 },
      ],
    });
    expect(ticketCount(a)).toBe(6);
  });

  it('gives the same hash to equivalent requests and a different one otherwise', () => {
    const one = normalizeSelection({ performanceId: 'p', seatIds: ['a', 'b'] });
    const same = normalizeSelection({
      performanceId: 'p',
      seatIds: ['b', 'a'],
    });
    const other = normalizeSelection({ performanceId: 'p', seatIds: ['a'] });
    expect(requestHash(one)).toBe(requestHash(same));
    expect(requestHash(one)).not.toBe(requestHash(other));
  });

  it.each([
    ['550e8400-e29b-41d4-a716-446655440000', true],
    ['order:42_retry.1', true],
    ['', false],
    ['has space', false],
    ['x'.repeat(101), false],
    [undefined, false],
  ])('idempotency key %j is valid: %s', (key, valid) => {
    expect(isValidIdempotencyKey(key)).toBe(valid);
  });
});
