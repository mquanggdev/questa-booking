import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service.js';
import { ConfigModule } from './config/config.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PaymentsProcessor } from './modules/payments/payments.processor.js';
import { ConcertsModule } from './modules/concerts/concerts.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { SeatBroadcastService } from './modules/seats/seat-broadcast.service.js';
import { SeatsModule } from './modules/seats/seats.module.js';
import { ReservationsProcessor } from './modules/reservations/reservations.processor.js';
import { KafkaModule } from './kafka/kafka.module.js';
import { WaitingRoomModule } from './modules/waiting-room/waiting-room.module.js';
import { WaitingRoomProcessor } from './modules/waiting-room/waiting-room.processor.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RedisModule } from './redis/redis.module.js';

// The worker process: same code base and services as the API, but no HTTP
// server; it only consumes queues.
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
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    ReservationsModule,
    PaymentsModule,
    ConcertsModule,
    SeatsModule,
    WaitingRoomModule,
    KafkaModule,
  ],
  providers: [
    ReservationsProcessor,
    PaymentsProcessor,
    SeatBroadcastService,
    WaitingRoomProcessor,
  ],
})
export class WorkerModule {}
