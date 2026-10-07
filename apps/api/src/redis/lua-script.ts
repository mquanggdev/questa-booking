import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * A Lua script run with EVALSHA (only the 40-byte hash travels), falling back
 * to EVAL once if Redis does not have it cached yet (e.g. after a restart).
 * Redis runs a script atomically: no other command interleaves with it.
 */
export class LuaScript {
  private readonly sha: string;

  constructor(private readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(
    redis: Redis,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (error instanceof Error && error.message.includes('NOSCRIPT')) {
        return redis.eval(this.source, keys.length, ...keys, ...args);
      }
      throw error;
    }
  }
}
