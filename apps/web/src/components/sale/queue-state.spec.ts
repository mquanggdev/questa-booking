import { describe, expect, it } from 'vitest';
import { applyPosition, formatWait, type QueueStatus } from './queue-state';

const waiting = (number: number, admittedThrough: number): QueueStatus => ({
  status: 'WAITING',
  number,
  position: number - admittedThrough,
  admittedThrough,
  waiting: 100,
});

describe('applyPosition', () => {
  it('moves me forward as people ahead are admitted', () => {
    const next = applyPosition(waiting(120, 0), {
      performanceId: 'p',
      admittedThrough: 50,
      waiting: 70,
    });
    expect(next).toMatchObject({
      position: 70,
      admittedThrough: 50,
      waiting: 70,
    });
  });

  it('ignores an update older than what I already know', () => {
    const current = waiting(120, 50);
    expect(
      applyPosition(current, {
        performanceId: 'p',
        admittedThrough: 40,
        waiting: 80,
      }),
    ).toBe(current);
  });

  it('leaves an admitted or unknown status alone', () => {
    const admitted: QueueStatus = {
      status: 'ADMITTED',
      expiresAt: '2026-10-12T10:00:00Z',
    };
    expect(
      applyPosition(admitted, {
        performanceId: 'p',
        admittedThrough: 10,
        waiting: 0,
      }),
    ).toBe(admitted);
    expect(
      applyPosition(undefined, {
        performanceId: 'p',
        admittedThrough: 10,
        waiting: 0,
      }),
    ).toBeUndefined();
  });
});

describe('formatWait', () => {
  it('seconds under a minute, minutes after', () => {
    expect(formatWait(0)).toBe('khoảng 1 giây');
    expect(formatWait(40)).toBe('khoảng 40 giây');
    expect(formatWait(170)).toBe('khoảng 3 phút');
  });
});
