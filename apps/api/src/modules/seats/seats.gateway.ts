import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { INSTANCE_ID } from '../../app.setup.js';
import { Public } from '../../common/auth/auth.decorators.js';
import { SeatEventsService } from './seat-events.service.js';
import {
  SEATS_NAMESPACE,
  SeatsEvent,
  performanceRoom,
} from './seats-realtime.constants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Realtime seat map, public like GET /performances/:id/seats. A client joins
 * one performance's room; batches are published by the worker's flusher and
 * relayed to every replica by the Redis adapter (RedisIoAdapter).
 */
@Public()
@WebSocketGateway({ namespace: SEATS_NAMESPACE })
export class SeatsGateway {
  constructor(private readonly seatEvents: SeatEventsService) {}

  /**
   * Watch one performance (a socket watches at most one). The ack carries
   * this replica's id (tests and demos show which replica serves the socket)
   * and the current seq, so a client can tell whether its snapshot is behind.
   */
  @SubscribeMessage(SeatsEvent.JOIN)
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { performanceId?: unknown } | undefined,
  ): Promise<{ instance: string; seq: number }> {
    const performanceId = body?.performanceId;
    if (typeof performanceId !== 'string' || !UUID.test(performanceId)) {
      throw new WsException('performanceId must be a UUID');
    }
    for (const room of socket.rooms) {
      if (room !== socket.id) await socket.leave(room);
    }
    await socket.join(performanceRoom(performanceId));
    return {
      instance: INSTANCE_ID,
      seq: await this.seatEvents.currentSeq(performanceId),
    };
  }
}
