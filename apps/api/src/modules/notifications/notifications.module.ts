import { Module } from '@nestjs/common';
import { ConcertsModule } from '../concerts/concerts.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { UsersModule } from '../users/users.module.js';
import { MailerService } from './mailer.service.js';
import { NotificationsHandler } from './notifications.handler.js';

// Worker only: the `notifications` consumer of orders.events.
@Module({
  imports: [UsersModule, TicketsModule, ConcertsModule],
  providers: [MailerService, NotificationsHandler],
  exports: [NotificationsHandler],
})
export class NotificationsModule {}
