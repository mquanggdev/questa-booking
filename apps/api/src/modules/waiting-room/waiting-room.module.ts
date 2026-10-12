import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { WaitingRoomController } from './waiting-room.controller.js';
import { WaitingRoomService } from './waiting-room.service.js';

// The API and the worker both use the service; the gateway (API only) is in
// WaitingRoomRealtimeModule and the processor is added by worker.module.ts.
@Module({
  imports: [ConcertsModule],
  controllers: [WaitingRoomController],
  providers: [WaitingRoomService],
  exports: [WaitingRoomService],
})
export class WaitingRoomModule {}
