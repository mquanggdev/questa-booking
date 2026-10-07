import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SeatsModule } from '../seats/seats.module.js';
import { HoldGateService } from './gate/hold-gate.service.js';
import { OrderCancellationController } from './order-cancellation.controller.js';
import { ReleaseService } from './release.service.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [ConcertsModule, SeatsModule, OrdersModule],
  controllers: [ReservationsController, OrderCancellationController],
  providers: [ReservationsService, ReleaseService, HoldGateService],
  exports: [ReleaseService, HoldGateService],
})
export class ReservationsModule {}
