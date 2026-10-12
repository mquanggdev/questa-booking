import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../config/app-config.service.js';
import { REDIS } from '../../redis/redis.module.js';

const LIST_VERSION = 'cache:concerts:list-version';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Cache-aside in Redis for the catalog reads (phase 7a): concert list,
 * concert detail, performance detail. Shared by every API replica.
 *
 * - Entries hold the RAW database records; who may see what (drafts are
 *   visible to their organizer only) is decided after reading, so one entry
 *   serves everyone and a draft can never leak through the cache.
 * - Writes invalidate: the detail keys they touch, and the list through a
 *   version number (every page of the old version is simply never read).
 * - The TTL bounds staleness in the rare race "read old row, invalidate,
 *   write old row into the cache"; ticket availability is never cached.
 * - Redis down means "no cache", never an error (fail-open).
 */
@Injectable()
export class CatalogCacheService {
  private readonly logger = new Logger(CatalogCacheService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  private get ttl(): number {
    return this.config.get('CATALOG_CACHE_TTL_SECONDS');
  }

  static concertKey = (id: string) => `cache:concert:${id}`;
  static performanceKey = (id: string) => `cache:performance:${id}`;

  /** Key of one list page, under the current list version. */
  async listKey(page: number, pageSize: number): Promise<string> {
    const version = (await this.redis.get(LIST_VERSION)) ?? '0';
    return `cache:concerts:v${version}:${page}:${pageSize}`;
  }

  /** The cached value, or load it and cache it. `null` is not cached. */
  async getOrLoad<T>(
    key: () => Promise<string> | string,
    load: () => Promise<T | null>,
  ): Promise<T | null> {
    if (this.ttl === 0) return load();
    let cacheKey: string | null = null;
    try {
      cacheKey = await key();
      const hit = await this.redis.get(cacheKey);
      if (hit !== null) {
        return JSON.parse(hit, (_k, v: unknown) =>
          typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v,
        ) as T;
      }
    } catch (error) {
      this.logger.warn(`Catalog cache read failed: ${String(error)}`);
      return load();
    }
    const value = await load();
    if (value !== null && cacheKey !== null) {
      await this.redis
        .set(cacheKey, JSON.stringify(value), 'EX', this.ttl)
        .catch((error: unknown) =>
          this.logger.warn(`Catalog cache write failed: ${String(error)}`),
        );
    }
    return value;
  }

  /**
   * After a write to a concert or one of its performances: drop the detail
   * entries and move the list to a new version.
   */
  async invalidate(ids: {
    concertId?: string;
    performanceId?: string;
  }): Promise<void> {
    const keys = [
      ...(ids.concertId ? [CatalogCacheService.concertKey(ids.concertId)] : []),
      ...(ids.performanceId
        ? [CatalogCacheService.performanceKey(ids.performanceId)]
        : []),
    ];
    try {
      const tx = this.redis.multi();
      if (keys.length > 0) tx.del(...keys);
      await tx.incr(LIST_VERSION).exec();
    } catch (error) {
      // Entries expire with their TTL anyway.
      this.logger.warn(`Catalog cache invalidation failed: ${String(error)}`);
    }
  }
}
