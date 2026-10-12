import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import { QueueStatusDto } from './dto/queue-status.dto.js';
import { WaitingRoomService } from './waiting-room.service.js';

@ApiTags('waiting-room')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller('performances/:id/queue')
export class WaitingRoomController {
  constructor(private readonly waitingRoom: WaitingRoomService) {}

  /**
   * Join the virtual waiting room. Joining again keeps your place; once
   * admitted it returns your pass. Live updates: WebSocket namespace /queue.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  join(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<QueueStatusDto> {
    return this.waitingRoom.join(id, user.id);
  }

  /** Your place in line, or your admission pass once it is your turn */
  @Get('me')
  me(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<QueueStatusDto> {
    return this.waitingRoom.status(id, user.id);
  }
}
