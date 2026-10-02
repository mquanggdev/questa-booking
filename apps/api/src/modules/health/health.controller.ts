import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';

type CheckResult = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // Liveness: the process is running. It never touches dependencies, so a
  // database outage does not get every API instance restarted.
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: the instance can serve traffic (database and Redis reachable).
  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    checks: Record<string, CheckResult>;
  }> {
    const [database, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    if (database === 'down' || redis === 'down') {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckResult> {
    try {
      await probe();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
