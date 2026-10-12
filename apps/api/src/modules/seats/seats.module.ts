import { Module } from '@nestjs/common';
import { SeatEventsService } from './seat-events.service.js';
import { SeatsService } from './seats.service.js';

@Module({
  providers: [SeatsService, SeatEventsService],
  exports: [SeatsService, SeatEventsService],
})
export class SeatsModule {}
