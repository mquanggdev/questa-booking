import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/auth.decorators.js';
import { MetricsService } from './metrics.service.js';

/**
 * GET /api/v1/metrics for Prometheus. Internal: Prometheus scrapes each
 * replica directly on the Docker network; Nginx refuses this path from
 * outside (docker/nginx/default.conf).
 */
@ApiExcludeController()
@Public()
// Named throttlers: a bare @SkipThrottle() only skips one called "default".
@SkipThrottle({ ip: true, user: true })
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(
    @Res()
    res: {
      setHeader(k: string, v: string): void;
      send(body: string): void;
    },
  ): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType());
    res.send(await this.metrics.text());
  }
}
