import { Module } from '@nestjs/common';
import { AnalyticsHandler } from '../modules/analytics/analytics.handler.js';
import { AnalyticsModule } from '../modules/analytics/analytics.module.js';
import { AuditHandler } from '../modules/audit/audit.handler.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { NotificationsHandler } from '../modules/notifications/notifications.handler.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { OutboxRelayService } from '../modules/outbox/outbox-relay.service.js';
import {
  EventConsumersService,
  ORDER_EVENT_HANDLERS,
  type OrderEventHandler,
} from './event-consumers.service.js';
import { KafkaService } from './kafka.service.js';

// Worker only (phase 8): the outbox relay and the three consumers of
// orders.events. The API process never imports this module.
@Module({
  imports: [NotificationsModule, AnalyticsModule, AuditModule],
  providers: [
    KafkaService,
    OutboxRelayService,
    EventConsumersService,
    {
      provide: ORDER_EVENT_HANDLERS,
      inject: [NotificationsHandler, AnalyticsHandler, AuditHandler],
      useFactory: (...handlers: OrderEventHandler[]) => handlers,
    },
  ],
  exports: [KafkaService, OutboxRelayService, EventConsumersService],
})
export class KafkaModule {}
