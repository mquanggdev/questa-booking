import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SeatsModule } from '../seats/seats.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { OrderPaymentController } from './order-payment.controller.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PerformanceCancellationService } from './performance-cancellation.service.js';
import { FakePaymentProvider } from './providers/fake.provider.js';
import { PaymentProvidersService } from './providers/payment-providers.service.js';
import { VnpayProvider } from './providers/vnpay.provider.js';
import { RefundsService } from './refunds.service.js';

@Module({
  imports: [
    ConcertsModule,
    OrdersModule,
    ReservationsModule,
    SeatsModule,
    TicketsModule,
  ],
  controllers: [OrderPaymentController, PaymentsController],
  providers: [
    PaymentsService,
    RefundsService,
    PerformanceCancellationService,
    PaymentProvidersService,
    VnpayProvider,
    FakePaymentProvider,
  ],
  exports: [RefundsService, PerformanceCancellationService],
})
export class PaymentsModule {}
