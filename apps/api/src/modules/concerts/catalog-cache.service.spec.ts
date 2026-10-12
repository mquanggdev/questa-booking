import type { Redis } from 'ioredis';
import type { AppConfigService } from '../../config/app-config.service.js';
import { CatalogCacheService } from './catalog-cache.service.js';

function service(redis: Partial<Redis>, ttl = 60): CatalogCacheService {
  const config = { get: () => ttl } as unknown as AppConfigService;
  return new CatalogCacheService(redis as Redis, config);
}

describe('CatalogCacheService', () => {
  it('fails open: Redis down means reading the database, not an error', async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn(),
    };
    const load = vi.fn().mockResolvedValue({ id: 'a' });
    await expect(service(redis).getOrLoad(() => 'k', load)).resolves.toEqual({
      id: 'a',
    });
    expect(load).toHaveBeenCalledOnce();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('gives Dates back as Dates', async () => {
    const startsAt = new Date('2026-11-06T13:00:00.000Z');
    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ startsAt, venue: 'x' })),
    };
    const value = await service(redis).getOrLoad<{ startsAt: Date }>(
      () => 'k',
      vi.fn(),
    );
    expect(value?.startsAt).toBeInstanceOf(Date);
    expect(value?.startsAt.getTime()).toBe(startsAt.getTime());
  });

  it('does not cache a missing record', async () => {
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    await service(redis).getOrLoad(
      () => 'k',
      () => Promise.resolve(null),
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('TTL 0 turns the cache off', async () => {
    const redis = { get: vi.fn(), set: vi.fn() };
    const load = vi.fn().mockResolvedValue({ id: 'a' });
    await service(redis, 0).getOrLoad(() => 'k', load);
    expect(redis.get).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it('single flight: 500 concurrent misses of one key load the record once', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    let resolve!: (v: { id: string }) => void;
    const load = vi.fn(() => new Promise<{ id: string }>((r) => (resolve = r)));
    const cache = service(redis);
    const reads = Array.from({ length: 500 }, () =>
      cache.getOrLoad(() => 'k', load),
    );
    await new Promise((r) => setTimeout(r, 10));
    resolve({ id: 'a' });
    expect(await Promise.all(reads)).toEqual(Array(500).fill({ id: 'a' }));
    expect(load).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledOnce();

    // Once settled, the next miss loads again (nothing is kept in memory).
    await cache.getOrLoad(
      () => 'k',
      () => Promise.resolve({ id: 'b' }),
    );
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('single flight: a failed load fails every waiter and is not kept', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const cache = service(redis);
    const failing = vi.fn().mockRejectedValue(new Error('pool exhausted'));
    const reads = [1, 2, 3].map(() => cache.getOrLoad(() => 'k', failing));
    for (const r of reads) await expect(r).rejects.toThrow('pool exhausted');
    expect(failing).toHaveBeenCalledOnce();
    const ok = vi.fn().mockResolvedValue({ id: 'a' });
    await expect(cache.getOrLoad(() => 'k', ok)).resolves.toEqual({ id: 'a' });
  });
});
