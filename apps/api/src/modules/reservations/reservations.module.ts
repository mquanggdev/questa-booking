import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SeatsModule } from '../seats/seats.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [ConcertsModule, SeatsModule, OrdersModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
