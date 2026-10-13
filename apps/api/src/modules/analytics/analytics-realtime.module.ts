import { Module } from '@nestjs/common';
import { AnalyticsModule } from './analytics.module.js';
import { SalesGateway } from './sales.gateway.js';

// API processes only: the worker publishes sales updates but serves no sockets.
@Module({
  imports: [AnalyticsModule],
  providers: [SalesGateway],
})
export class AnalyticsRealtimeModule {}
