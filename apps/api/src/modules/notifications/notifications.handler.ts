import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderEventHandler } from '../../kafka/event-consumers.service.js';
import { ConsumerName } from '../../kafka/kafka.constants.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { OrderEventType, type OrderEvent } from '../outbox/order-events.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { UsersService } from '../users/users.service.js';
import { emailFor } from './emails.js';
import { MailerService } from './mailer.service.js';

/**
 * Consumer `notifications`: emails the buyer (ticket QR codes after
 * payment, performance cancelled, refund done).
 *
 * An email cannot be part of a database transaction. The email is sent
 * inside apply(), before the transaction that records the event as
 * processed commits: if sending fails, nothing is recorded and the event is
 * retried; if the process dies after sending but before the commit, the
 * email goes out again. So: never lost, rarely twice, with the same
 * Message-ID (ADR-0017).
 */
@Injectable()
export class NotificationsHandler implements OrderEventHandler {
  readonly name = ConsumerName.NOTIFICATIONS;

  constructor(
    private readonly users: UsersService,
    private readonly tickets: TicketsService,
    private readonly performances: PerformancesService,
    private readonly mailer: MailerService,
    private readonly config: AppConfigService,
  ) {}

  async apply(event: OrderEvent, _tx: Prisma.TransactionClient): Promise<void> {
    const user = await this.users.findById(event.data.userId);
    if (!user) return; // account gone: nobody to write to
    const performance = await this.performances.detailsOf(
      event.data.performanceId,
    );
    const email = await emailFor(event, {
      fullName: user.fullName,
      concertName: performance.concertName,
      venue: performance.venue,
      startsAt: performance.startsAt,
      tickets:
        event.eventType === OrderEventType.PAID
          ? await this.tickets.listForOrder(event.data.orderId)
          : [],
      webUrl: this.config.get('PUBLIC_BASE_URL'),
    });
    if (!email) return;
    await this.mailer.send(user.email, email, `<${event.eventId}@questa.test>`);
  }
}
