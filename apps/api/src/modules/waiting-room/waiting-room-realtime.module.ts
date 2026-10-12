import { Module } from '@nestjs/common';
import { WaitingRoomGateway } from './waiting-room.gateway.js';
import { WaitingRoomModule } from './waiting-room.module.js';

// API processes only: the worker publishes queue events but serves no sockets.
@Module({
  imports: [WaitingRoomModule],
  providers: [WaitingRoomGateway],
})
export class WaitingRoomRealtimeModule {}
