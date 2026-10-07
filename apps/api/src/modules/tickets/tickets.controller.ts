import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import {
  CheckInDto,
  CheckInResponseDto,
  TicketResponseDto,
} from './dto/ticket.dto.js';
import { TicketsService } from './tickets.service.js';

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  /** My tickets with their QR codes */
  @Roles(Role.CUSTOMER)
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<TicketResponseDto[]> {
    return this.tickets.listForUser(user.id);
  }

  /** Scans a ticket at the gate; each ticket is accepted exactly once */
  @Roles(Role.STAFF)
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  checkIn(
    @CurrentUser() staff: AuthUser,
    @Body() dto: CheckInDto,
  ): Promise<CheckInResponseDto> {
    return this.tickets.checkIn(dto.code, staff.id);
  }
}
