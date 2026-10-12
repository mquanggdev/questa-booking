import { type ExecutionContext, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './common/throttle/redis-throttler.storage.js';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service.js';
import { ConfigModule } from './config/config.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConcertsModule } from './modules/concerts/concerts.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { SeatsRealtimeModule } from './modules/seats/seats-realtime.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { REDIS, RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport: config.get('LOG_PRETTY')
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          // Health probes run every few seconds; logging them is noise.
          autoLogging: {
            ignore: (req) => req.url?.includes('/health') ?? false,
          },
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
          ],
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, REDIS],
      useFactory: (config: AppConfigService, redis: Redis) => ({
        throttlers: [
          // Every request, by client IP (X-Forwarded-For from Nginx).
          {
            name: 'ip',
            ttl: 60_000,
            limit: config.get('RATE_LIMIT_IP_PER_MINUTE'),
          },
          // Signed-in requests, by account: one user behind many IPs too.
          {
            name: 'user',
            ttl: 60_000,
            limit: config.get('RATE_LIMIT_USER_PER_MINUTE'),
            getTracker: (req: { user?: { id: string } }) => req.user?.id ?? '',
            skipIf: (ctx: ExecutionContext) =>
              !ctx.switchToHttp().getRequest<{ user?: unknown }>().user,
          },
        ],
        // Shared by all replicas.
        storage: new RedisThrottlerStorage(redis),
        // WebSocket messages are not throttled (the seat map is public and
        // cheap); load tests turn limiting off.
        skipIf: (ctx: ExecutionContext) =>
          ctx.getType() !== 'http' || !config.get('RATE_LIMIT_ENABLED'),
      }),
    }),
    QueueModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ConcertsModule,
    OrdersModule,
    ReservationsModule,
    PaymentsModule,
    TicketsModule,
    SeatsRealtimeModule,
  ],
})
export class AppModule {}
