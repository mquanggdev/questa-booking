import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Roles, type AuthUser } from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { Role } from '../../generated/prisma/client.js';
import {
  SALES_NAMESPACE,
  SalesEvent,
  salesRoom,
} from './analytics.constants.js';
import type { SalesStatsDto } from './dto/sales-stats.dto.js';
import { SalesStatsService } from './sales-stats.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The live sales dashboard (organizer of the concert only). Updates are
 * published by the analytics consumer in the worker and relayed to every
 * replica by the Redis adapter.
 */
@WebSocketGateway({ namespace: SALES_NAMESPACE })
export class SalesGateway {
  constructor(private readonly stats: SalesStatsService) {}

  @Roles(Role.ORGANIZER)
  @SubscribeMessage(SalesEvent.JOIN)
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { performanceId?: unknown } | undefined,
  ): Promise<SalesStatsDto> {
    const performanceId = body?.performanceId;
    if (typeof performanceId !== 'string' || !UUID.test(performanceId)) {
      throw new WsException('performanceId must be a UUID');
    }
    const user = (socket.data as { user: AuthUser }).user;
    let snapshot: SalesStatsDto;
    try {
      // Checks ownership first: 403 for another organizer's performance.
      snapshot = await this.stats.forOrganizer(performanceId, user);
    } catch (error) {
      throw new WsException(
        error instanceof AppException ? error.message : 'Not allowed',
      );
    }
    for (const room of socket.rooms) {
      if (room !== socket.id) await socket.leave(room);
    }
    await socket.join(salesRoom(performanceId));
    return snapshot;
  }
}
