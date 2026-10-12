import type { Redis } from 'ioredis';
import type { AppConfigService } from '../../config/app-config.service.js';
import type { PerformancesService } from '../concerts/performances.service.js';
import { SeatBroadcastService } from './seat-broadcast.service.js';
import type { SeatEventsService } from './seat-events.service.js';
import type { SeatsService } from './seats.service.js';

const taken = { seq: 7, seatIds: ['s1'], zoneIds: ['z1'] };

function setup(publish: Redis['publish']) {
  const seatEvents = {
    dirtyPerformances: vi.fn().mockResolvedValue(['p1']),
    take: vi.fn().mockResolvedValue(taken),
    markChanged: vi.fn().mockResolvedValue(undefined),
  };
  const seats = {
    statusesOf: vi
      .fn()
      .mockResolvedValue([{ id: 's1', zoneId: 'z1', status: 'HELD' }]),
  };
  const performances = { zoneAvailability: vi.fn().mockResolvedValue([]) };
  const service = new SeatBroadcastService(
    { publish } as unknown as Redis,
    seatEvents as unknown as SeatEventsService,
    seats as unknown as SeatsService,
    performances as unknown as PerformancesService,
    {} as AppConfigService,
  );
  return { service, seatEvents };
}

describe('SeatBroadcastService', () => {
  it('publishes one batch per changed performance', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const { service, seatEvents } = setup(publish);
    await expect(service.flush()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(seatEvents.markChanged).not.toHaveBeenCalled();
  });

  it('a failed publish fails the flush and marks the seats again, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const publish = vi
        .fn()
        .mockRejectedValue(new Error('Connection is closed.'));
      const { service, seatEvents } = setup(publish);
      await expect(service.flush()).rejects.toThrow('Connection is closed.');
      expect(seatEvents.markChanged).toHaveBeenCalledWith('p1', taken);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
