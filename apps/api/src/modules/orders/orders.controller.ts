import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import { OrderResponseDto } from './dto/order.dto.js';
import { OrdersService } from './orders.service.js';

@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** My orders, newest first */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<OrderResponseDto[]> {
    return this.orders.listForUser(user.id);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return this.orders.getForUser(user.id, id);
  }
}
