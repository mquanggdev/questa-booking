import type { OrderEvent } from '../outbox/order-events.js';
import type { TicketResponseDto } from '../tickets/dto/ticket.dto.js';
import { emailFor, type EmailContext } from './emails.js';

const base = {
  eventId: 'e1',
  occurredAt: '2026-10-13T00:00:00.000Z',
  version: 1,
};
const data = {
  orderId: 'o1',
  userId: 'u1',
  performanceId: 'p1',
  totalAmount: 1_500_000,
  items: [],
};
const ticket = (code: string, seatLabel: string | null) =>
  ({
    code,
    zoneName: seatLabel ? 'VIP' : 'GA',
    seatLabel,
  }) as TicketResponseDto;
const ctx: EmailContext = {
  fullName: 'Lan <script>',
  concertName: 'Questa Fest',
  venue: 'My Dinh',
  startsAt: new Date('2026-11-06T13:00:00Z'),
  tickets: [ticket('code-1', 'A1'), ticket('code-2', null)],
  webUrl: 'https://questa.test',
};

describe('emailFor', () => {
  it('order.paid: one inline QR code per ticket, linked from the body', async () => {
    const email = await emailFor(
      { ...base, eventType: 'order.paid', data },
      ctx,
    );
    expect(email?.subject).toBe('Vé của bạn: Questa Fest');
    expect(email?.attachments.map((a) => a.cid)).toEqual([
      'ticket-1@questa',
      'ticket-2@questa',
    ]);
    expect(email?.html).toContain('cid:ticket-1@questa');
    expect(email?.text).toContain('VIP · ghế A1');
    expect(email?.text).toContain('GA · vé đứng');
    expect(email?.text).toContain('1.500.000');
    // Names are escaped in HTML.
    expect(email?.html).toContain('Lan &lt;script&gt;');
    expect(email?.html).not.toContain('<script>');
    // Real PNG images.
    expect(email?.attachments[0]?.content.subarray(1, 4).toString()).toBe(
      'PNG',
    );
  });

  it('a performance cancelled after payment says the money comes back', async () => {
    const email = await emailFor(
      {
        ...base,
        eventType: 'order.cancelled',
        data: { ...data, reason: 'PERFORMANCE_CANCELLED', wasPaid: true },
      },
      ctx,
    );
    expect(email?.subject).toBe('Đêm diễn đã bị hủy: Questa Fest');
    expect(email?.text).toContain('sẽ được hoàn tự động');
  });

  it('no email when the buyers already know: own cancellation, expiry', async () => {
    const own: OrderEvent = {
      ...base,
      eventType: 'order.cancelled',
      data: { ...data, reason: 'CUSTOMER', wasPaid: false },
    };
    const expired: OrderEvent = { ...base, eventType: 'order.expired', data };
    expect(await emailFor(own, ctx)).toBeNull();
    expect(await emailFor(expired, ctx)).toBeNull();
  });

  it('order.refunded names the amount', async () => {
    const email = await emailFor(
      { ...base, eventType: 'order.refunded', data },
      ctx,
    );
    expect(email?.subject).toBe('Đã hoàn tiền: Questa Fest');
    expect(email?.text).toContain('1.500.000');
  });
});
