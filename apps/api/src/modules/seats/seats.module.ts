import { Module } from '@nestjs/common';
import { SeatsService } from './seats.service.js';

@Module({
  providers: [SeatsService],
  exports: [SeatsService],
})
export class SeatsModule {}
