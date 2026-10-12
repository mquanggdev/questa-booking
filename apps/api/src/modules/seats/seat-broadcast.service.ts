import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { hostname } from 'node:os';
import { AppConfigService } from '../../config/app-config.service.js';
import { RedisEventPublisher } from '../../redis/redis-event-publisher.js';
import { REDIS } from '../../redis/redis.module.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { SeatEventsService } from './seat-events.service.js';
import {
  SEATS_NAMESPACE,
  SeatsEvent,
  performanceRoom,
  type SeatsBatch,
} from './seats-realtime.constants.js';
import { SeatsService } from './seats.service.js';

const LOCK_KEY = 'seats:flusher-lock';
// Take the lock, or keep it if we already hold it.
const LOCK_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/**
 * The single publisher of seat-map batches (worker process only). Every
 * SEAT_BROADCAST_EVERY_MS it takes the marks of each changed performance
 * with the next seq, reads the CURRENT state from PostgreSQL and publishes
 * one batch per performance through Redis (spec: batches every 200-500 ms).
 *
 * One flusher at a time (a Redis lock), so batches leave in seq order and
 * each one reads a state at least as recent as the previous one.
 */
@Injectable()
export class SeatBroadcastService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SeatBroadcastService.name);
  private readonly owner = `${hostname()}:${process.pid}`;
  private readonly publisher: RedisEventPublisher;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly seatEvents: SeatEventsService,
    private readonly seats: SeatsService,
    private readonly performances: PerformancesService,
    private readonly config: AppConfigService,
  ) {
    this.publisher = new RedisEventPublisher(redis, SEATS_NAMESPACE);
  }

  onApplicationBootstrap(): void {
    const every = this.config.get('SEAT_BROADCAST_EVERY_MS');
    this.timer = setInterval(() => void this.tick(every), every);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async tick(every: number): Promise<void> {
    if (this.running) return; // a slow flush is never overlapped by the next
    this.running = true;
    try {
      const mine = await this.redis.eval(
        LOCK_SCRIPT,
        1,
        LOCK_KEY,
        this.owner,
        String(every * 8),
      );
      if (mine === 1) await this.flush();
    } catch (error) {
      this.logger.warn(`Seat broadcast failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Publishes one batch per changed performance. Returns how many. */
  async flush(): Promise<number> {
    let published = 0;
    for (const performanceId of await this.seatEvents.dirtyPerformances()) {
      const taken = await this.seatEvents.take(performanceId);
      if (!taken) continue;
      try {
        const seats = await this.seats.statusesOf(taken.seatIds);
        const zoneIds = new Set([
          ...taken.zoneIds,
          ...seats.map((s) => s.zoneId),
        ]);
        const batch: SeatsBatch = {
          performanceId,
          seq: taken.seq,
          seats: seats.map((s) => ({ id: s.id, status: s.status })),
          zones: await this.performances.zoneAvailability([...zoneIds]),
        };
        await this.publisher.emit(
          performanceRoom(performanceId),
          SeatsEvent.BATCH,
          batch,
        );
        published += 1;
      } catch (error) {
        // The seq is used up: clients see a gap and reload the snapshot.
        // Marking again makes the next batch carry these changes too.
        await this.seatEvents.markChanged(performanceId, taken);
        throw error;
      }
    }
    return published;
  }
}
