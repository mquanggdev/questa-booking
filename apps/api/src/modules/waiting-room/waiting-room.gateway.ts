import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Roles, type AuthUser } from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import type { QueueStatusDto } from './dto/queue-status.dto.js';
import {
  lineRoom,
  personRoom,
  QUEUE_NAMESPACE,
  QueueEvent,
} from './waiting-room.constants.js';
import { WaitingRoomService } from './waiting-room.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live place in line. Authenticated (handshake auth.token): a person only
 * ever joins their own room. Joining the line itself is POST /queue; this
 * only follows it. Events are published by the worker's admitter and
 * relayed to every replica by the Redis adapter.
 */
@WebSocketGateway({ namespace: QUEUE_NAMESPACE })
export class WaitingRoomGateway {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  /**
   * Follow one performance's line (a socket follows at most one). The ack
   * is the current status, so nothing published before the join is missed.
   */
  @Roles(Role.CUSTOMER)
  @SubscribeMessage(QueueEvent.JOIN)
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { performanceId?: unknown } | undefined,
  ): Promise<QueueStatusDto> {
    const performanceId = body?.performanceId;
    if (typeof performanceId !== 'string' || !UUID.test(performanceId)) {
      throw new WsException('performanceId must be a UUID');
    }
    // Set by JwtAuthGuard for this connection.
    const user = (socket.data as { user: AuthUser }).user;
    for (const room of socket.rooms) {
      if (room !== socket.id) await socket.leave(room);
    }
    // Join first, then read: an event published in between is either in
    // the status read below or delivered to the socket, never lost.
    await socket.join([
      lineRoom(performanceId),
      personRoom(performanceId, user.id),
    ]);
    return this.waitingRoom.status(performanceId, user.id);
  }
}
