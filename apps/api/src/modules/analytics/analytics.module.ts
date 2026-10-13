import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { SeatsModule } from '../seats/seats.module.js';
import { WaitingRoomModule } from '../waiting-room/waiting-room.module.js';
import { AnalyticsHandler } from './analytics.handler.js';
import { SalesController } from './sales.controller.js';
import { SalesStatsService } from './sales-stats.service.js';

// The API serves GET /performances/:id/stats; the worker runs the consumer
// (AnalyticsHandler). The /sales gateway is in AnalyticsRealtimeModule.
@Module({
  imports: [ConcertsModule, SeatsModule, WaitingRoomModule],
  controllers: [SalesController],
  providers: [SalesStatsService, AnalyticsHandler],
  exports: [SalesStatsService, AnalyticsHandler],
})
export class AnalyticsModule {}
