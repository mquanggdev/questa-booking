import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service.js';
import { ConfigModule } from './config/config.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConcertsModule } from './modules/concerts/concerts.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';

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
    HealthModule,
    AuthModule,
    UsersModule,
    ConcertsModule,
  ],
})
export class AppModule {}
