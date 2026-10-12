import { Module } from '@nestjs/common';
import { SeatsGateway } from './seats.gateway.js';
import { SeatsModule } from './seats.module.js';

// API processes only: the worker publishes batches but serves no sockets.
@Module({
  imports: [SeatsModule],
  providers: [SeatsGateway],
})
export class SeatsRealtimeModule {}
