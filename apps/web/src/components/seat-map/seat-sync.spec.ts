import { describe, expect, it } from 'vitest';
import { applyBatches, type SeatMap, type SeatsBatch } from './seat-sync';

const P = 'perf-1';

function snapshot(seq: number): SeatMap {
  return {
    performanceId: P,
    seq,
    zones: [
      {
        id: 'z1',
        name: 'A',
        type: 'SEATED',
        price: 1,
        capacity: 2,
        available: 2,
      },
      {
        id: 'z2',
        name: 'GA',
        type: 'STANDING',
        price: 1,
        capacity: 10,
        available: 10,
      },
    ],
    seats: [
      { id: 's1', zoneId: 'z1', row: 'A', number: 1, status: 'AVAILABLE' },
      { id: 's2', zoneId: 'z1', row: 'A', number: 2, status: 'AVAILABLE' },
    ],
  };
}

const batch = (
  seq: number,
  seats: [string, string][] = [],
  zones: [string, number][] = [],
): SeatsBatch => ({
  performanceId: P,
  seq,
  seats: seats.map(([id, status]) => ({ id, status })),
  zones: zones.map(([id, available]) => ({ id, available })),
});

describe('applyBatches (seq rule of the realtime seat map)', () => {
  it('applies the next batches in order and advances seq', () => {
    const r = applyBatches(snapshot(4), [
      batch(6, [['s1', 'SOLD']], [['z1', 1]]),
      batch(5, [['s1', 'HELD']], [['z1', 1]]),
    ]);
    expect(r.reload).toBe(false);
    expect(r.map.seq).toBe(6);
    expect(r.map.seats.find((s) => s.id === 's1')?.status).toBe('SOLD');
    expect(r.map.zones.find((z) => z.id === 'z1')?.available).toBe(1);
  });

  it('skips batches already contained in the snapshot', () => {
    const snap = snapshot(7);
    const r = applyBatches(snap, [
      batch(6, [['s1', 'HELD']]),
      batch(7, [['s2', 'HELD']]),
    ]);
    expect(r).toEqual({ map: snap, pending: [], reload: false });
  });

  it('asks for a fresh snapshot when the first batch is not seq + 1', () => {
    const r = applyBatches(snapshot(4), [batch(6, [['s1', 'HELD']])]);
    expect(r.reload).toBe(true);
    expect(r.map.seq).toBe(4);
    expect(r.map.seats.find((s) => s.id === 's1')?.status).toBe('AVAILABLE');
  });

  it('stops at a hole in the middle and asks for a reload', () => {
    const r = applyBatches(snapshot(1), [
      batch(2, [['s1', 'HELD']]),
      batch(4, [['s2', 'HELD']]),
    ]);
    expect(r.reload).toBe(true);
    expect(r.map.seq).toBe(2);
    expect(r.map.seats.find((s) => s.id === 's2')?.status).toBe('AVAILABLE');
  });

  it('tolerates the same batch twice', () => {
    const b = batch(2, [['s1', 'HELD']], [['z2', 9]]);
    const r = applyBatches(snapshot(1), [b, b]);
    expect(r.reload).toBe(false);
    expect(r.map.seq).toBe(2);
    expect(r.map.zones.find((z) => z.id === 'z2')?.available).toBe(9);
  });

  it('ignores batches of another performance', () => {
    const snap = snapshot(1);
    const r = applyBatches(snap, [
      { ...batch(2, [['s1', 'HELD']]), performanceId: 'other' },
    ]);
    expect(r.map).toBe(snap);
  });
});
