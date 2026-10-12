import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/** Not exported by the package root; derived from the interface instead. */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * One fixed window per key, counted and checked in a single atomic step, so
 * every API replica shares the same counters (spec: "lưu bộ đếm trong
 * Redis để đúng trên nhiều instance"). In-memory counters would give each
 * replica its own quota: 2 replicas, twice the limit.
 *   KEYS[1] hit counter  KEYS[2] block marker
 *   ARGV[1] window ms    ARGV[2] limit         ARGV[3] block ms
 * Returns { hits, window ms left, blocked (0/1), block ms left }.
 */
const INCREMENT = `
local blocked = redis.call('PTTL', KEYS[2])
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local left = redis.call('PTTL', KEYS[1])
if blocked > 0 then return { hits, left, 1, blocked } end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, left, 1, tonumber(ARGV[3]) }
end
return { hits, left, 0, 0 }
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `ratelimit:${throttlerName}:${key}`;
    const [hits, left, blocked, blockLeft] = (await this.redis.eval(
      INCREMENT,
      2,
      `${base}:hits`,
      `${base}:block`,
      ttl,
      limit,
      blockDuration > 0 ? blockDuration : ttl,
    )) as [number, number, number, number];
    // The guard expects seconds (it writes them into the headers).
    return {
      totalHits: hits,
      timeToExpire: Math.max(Math.ceil(left / 1000), 0),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.max(Math.ceil(blockLeft / 1000), 0),
    };
  }
}
