import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';

/** What changed in one performance, as recorded after a commit. */
export interface SeatChange {
  seatIds?: readonly string[];
  /** Standing zones whose counters moved. */
  zoneIds?: readonly string[];
}

const DIRTY_PERFORMANCES = 'seats:dirty-perfs';
const dirtyKey = (performanceId: string) => `seats:dirty:${performanceId}`;
export const seqKey = (performanceId: string) => `seats:seq:${performanceId}`;

/**
 * Takes everything marked for one performance and gives it the next `seq`,
 * atomically: a change marked after this runs stays for the next flush.
 * Returns {} when nothing was marked.
 *   KEYS[1] dirty set of the performance  KEYS[2] dirty performances
 *   KEYS[3] seq counter                   ARGV[1] performance id
 */
const TAKE_SCRIPT = `
local members = redis.call('SMEMBERS', KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
if #members == 0 then return {} end
local seq = redis.call('INCR', KEYS[3])
table.insert(members, 1, tostring(seq))
return members
`;

/**
 * The realtime seat map's bookkeeping in Redis (spec, "Sơ đồ ghế realtime").
 *
 * Writers (holds, payments, releases, in any API replica or the worker) only
 * MARK what changed, after their transaction committed. A single flusher in
 * the worker (SeatBroadcastService) takes the marks, assigns the next `seq`
 * and reads the CURRENT state from PostgreSQL. Ordering then holds by
 * construction:
 *   - every mark is set after its commit, and seq is assigned after the mark
 *     is taken, so a batch with seq N reflects every change it carries;
 *   - a snapshot reads seq BEFORE reading the seats, so any change whose
 *     seq <= snapshot seq was committed before the snapshot's query and is
 *     already in it. Clients apply only batches with a greater seq.
 */
@Injectable()
export class SeatEventsService {
  private readonly logger = new Logger(SeatEventsService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Best effort: if Redis is down the seat map is not pushed, but clients
   * still converge (they reload the snapshot on reconnect and every 30 s).
   * Never throws, so a committed purchase is never reported as failed.
   */
  async markChanged(performanceId: string, change: SeatChange): Promise<void> {
    const members = [
      ...(change.seatIds ?? []).map((id) => `s:${id}`),
      ...(change.zoneIds ?? []).map((id) => `z:${id}`),
    ];
    if (members.length === 0) return;
    try {
      await this.redis
        .multi()
        .sadd(dirtyKey(performanceId), ...members)
        .sadd(DIRTY_PERFORMANCES, performanceId)
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not mark seat changes of ${performanceId}: ${String(error)}`,
      );
    }
  }

  /** Current seq of a performance (0 before its first change). */
  async currentSeq(performanceId: string): Promise<number> {
    try {
      return Number((await this.redis.get(seqKey(performanceId))) ?? 0);
    } catch {
      return 0;
    }
  }

  /** Performances with marks waiting to be flushed. */
  dirtyPerformances(): Promise<string[]> {
    return this.redis.smembers(DIRTY_PERFORMANCES);
  }

  /** Takes the marks of one performance with their seq, or null if none. */
  async take(
    performanceId: string,
  ): Promise<{ seq: number; seatIds: string[]; zoneIds: string[] } | null> {
    const result = (await this.redis.eval(
      TAKE_SCRIPT,
      3,
      dirtyKey(performanceId),
      DIRTY_PERFORMANCES,
      seqKey(performanceId),
      performanceId,
    )) as string[];
    if (result.length === 0) return null;
    const [seq, ...members] = result;
    return {
      seq: Number(seq),
      seatIds: members.filter((m) => m.startsWith('s:')).map((m) => m.slice(2)),
      zoneIds: members.filter((m) => m.startsWith('z:')).map((m) => m.slice(2)),
    };
  }
}
