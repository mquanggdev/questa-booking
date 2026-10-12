import { estimateWaitMs, pollAfterMs } from './queue-estimate.js';

describe('waiting room estimates', () => {
  it('one tick per batch of people, after the opening', () => {
    expect(estimateWaitMs(1, 0, 100, 1000)).toBe(1000);
    expect(estimateWaitMs(100, 0, 100, 1000)).toBe(1000);
    expect(estimateWaitMs(101, 0, 100, 1000)).toBe(2000);
    expect(estimateWaitMs(2000, 0, 100, 1000)).toBe(20_000);
    expect(estimateWaitMs(50, 15_000, 100, 1000)).toBe(16_000);
    expect(estimateWaitMs(50, -5000, 100, 1000)).toBe(1000);
  });

  it('far back asks rarely, near the front asks every second, never beyond 30 s', () => {
    expect(pollAfterMs(1000)).toBe(1000);
    expect(pollAfterMs(20_000)).toBe(5000);
    expect(pollAfterMs(10 * 60_000)).toBe(30_000);
  });
});
