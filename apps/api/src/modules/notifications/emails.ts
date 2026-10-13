import QRCode from 'qrcode';
import type { TicketResponseDto } from '../tickets/dto/ticket.dto.js';
import { OrderEventType, type OrderEvent } from '../outbox/order-events.js';

export interface Email {
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; content: Buffer; cid: string }[];
}

export interface EmailContext {
  fullName: string;
  concertName: string;
  venue: string;
  startsAt: Date;
  /** order.paid: the tickets to attach. */
  tickets: TicketResponseDto[];
  /** Absolute URL of the web app, for links. */
  webUrl: string;
}

const vnd = (amount: number) =>
  `${new Intl.NumberFormat('vi-VN').format(amount)} ₫`;
const when = (date: Date) =>
  new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(date);
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/**
 * The email for one order event, in Vietnamese. Null when the event needs
 * no email: an unpaid hold that expired or that the buyer cancelled.
 */
export async function emailFor(
  event: OrderEvent,
  ctx: EmailContext,
): Promise<Email | null> {
  const show = `${ctx.concertName}, ${when(ctx.startsAt)}, ${ctx.venue}`;
  const hello = `Chào ${ctx.fullName},`;
  switch (event.eventType) {
    case OrderEventType.PAID: {
      const lines = ctx.tickets.map(
        (t) =>
          `${t.zoneName}${t.seatLabel ? ` · ghế ${t.seatLabel}` : ' · vé đứng'}`,
      );
      const attachments = await Promise.all(
        ctx.tickets.map(async (t, i) => ({
          filename: `ve-${i + 1}.png`,
          content: await QRCode.toBuffer(t.code, { margin: 1, width: 240 }),
          cid: `ticket-${i + 1}@questa`,
        })),
      );
      return {
        subject: `Vé của bạn: ${ctx.concertName}`,
        text: [
          hello,
          '',
          `Thanh toán ${vnd(event.data.totalAmount)} đã thành công. Vé của bạn cho ${show}:`,
          ...lines.map((l) => `- ${l}`),
          '',
          `Mã QR của từng vé ở tệp đính kèm, và tại ${ctx.webUrl}/tickets.`,
        ].join('\n'),
        html: `<p>${escape(hello)}</p>
<p>Thanh toán <b>${vnd(event.data.totalAmount)}</b> đã thành công. Vé của bạn cho <b>${escape(show)}</b>:</p>
${ctx.tickets
  .map(
    (t, i) => `<div style="display:inline-block;margin:8px;text-align:center">
  <img src="cid:ticket-${i + 1}@questa" width="160" height="160" alt="QR vé ${i + 1}"><br>
  ${escape(lines[i]!)}</div>`,
  )
  .join('\n')}
<p>Xuất trình mã QR ở cổng vào. Xem lại vé: <a href="${ctx.webUrl}/tickets">${ctx.webUrl}/tickets</a></p>`,
        attachments,
      };
    }
    case OrderEventType.CANCELLED: {
      if (event.data.reason !== 'PERFORMANCE_CANCELLED') return null;
      const text = event.data.wasPaid
        ? `Rất tiếc, đêm diễn ${show} đã bị hủy. Vé của bạn không còn hiệu lực và ${vnd(event.data.totalAmount)} sẽ được hoàn tự động; chúng tôi sẽ báo khi tiền đã được hoàn.`
        : `Rất tiếc, đêm diễn ${show} đã bị hủy. Vé bạn đang giữ đã được nhả, bạn không bị trừ tiền.`;
      return plain(`Đêm diễn đã bị hủy: ${ctx.concertName}`, hello, text);
    }
    case OrderEventType.REFUNDED:
      return plain(
        `Đã hoàn tiền: ${ctx.concertName}`,
        hello,
        `${vnd(event.data.totalAmount)} cho đơn hàng của đêm diễn ${show} đã được hoàn về phương thức thanh toán của bạn.`,
      );
    default:
      // order.expired, and order.cancelled by the buyer: they know already.
      return null;
  }
}

function plain(subject: string, hello: string, body: string): Email {
  return {
    subject,
    text: `${hello}\n\n${body}`,
    html: `<p>${escape(hello)}</p><p>${escape(body)}</p>`,
    attachments: [],
  };
}
