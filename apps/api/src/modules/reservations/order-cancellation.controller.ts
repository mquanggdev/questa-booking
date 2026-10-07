import {
  Controller,
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
import { ReleaseService } from './release.service.js';

// Lives in the reservations module (not orders) because cancelling releases
// seats and standing tickets, which only this module orchestrates.
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller('orders')
export class OrderCancellationController {
  constructor(private readonly release: ReleaseService) {}

  /** Cancels my PENDING order and releases its tickets immediately */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.release.cancel(user.id, id);
  }
}
