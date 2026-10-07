import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import {
  PAYMENTS_DEAD_LETTER_QUEUE,
  PAYMENTS_QUEUE,
  RESERVATIONS_QUEUE,
} from './queue.constants.js';

/** ioredis connection options from a redis:// URL (host, port, password, db). */
export function redisConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number(parsed.pathname.replace('/', '') || 0),
    // Required by BullMQ workers: they block on Redis and must never give up
    // after a fixed number of retries.
    maxRetriesPerRequest: null,
  };
}

// Producers (API) and consumers (worker) share this registration. Processors
// are added only by the worker process (see worker.module.ts).
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: redisConnection(config.get('REDIS_URL')),
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: 1000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: RESERVATIONS_QUEUE },
      { name: PAYMENTS_QUEUE },
      { name: PAYMENTS_DEAD_LETTER_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
