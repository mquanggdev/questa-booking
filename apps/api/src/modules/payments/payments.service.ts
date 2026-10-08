import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isPgError } from '../../common/errors/pg-error.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import { OrdersService, type PaidItem } from '../orders/orders.service.js';
import {
  ReleaseService,
  type ReleasedSet,
} from '../reservations/release.service.js';
import { SeatsService } from '../seats/seats.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import type {
  CheckoutResponseDto,
  FakeCheckoutResponseDto,
  FakeCompleteResponseDto,
  PaymentReturnResponseDto,
} from './dto/payment.dto.js';
import type { FakeOutcome } from './providers/fake.provider.js';
import type { PaymentProvider } from './providers/payment-provider.js';
import { PaymentProvidersService } from './providers/payment-providers.service.js';
import {
  IpnReply,
  txnRefOf,
  type CallbackResult,
} from './providers/vnpay-protocol.js';
import { RefundsService } from './refunds.service.js';

export type IpnResponse = (typeof IpnReply)[keyof typeof IpnReply];

interface PaymentRow {
  id: string;
  orderId: string;
  provider: string;
  amount: number;
  status: string;
}

interface Settlement {
  outcome: 'paid' | 'refund' | 'duplicate';
  released: ReleasedSet | null;
  refundId: string | null;
}

/** IPN answers after which VNPay stops delivering. */
const FINAL_IPN_CODES = new Set<string>([
  IpnReply.CONFIRMED.RspCode,
  IpnReply.ALREADY_CONFIRMED.RspCode,
]);
/** The fake gateway delivers an IPN at most this many times (~4 s). */
const FAKE_IPN_DELIVERIES = 5;

const paymentRow = {
  id: true,
  orderId: true,
  provider: true,
  amount: true,
  status: true,
} as const;

/**
 * Flow B (spec, section 5). The IPN is the only thing that changes an
 * order's state; the return URL is for display. Every IPN is answered with
 * VNPay's RspCode, and re-delivering one is always safe.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProvidersService,
    private readonly orders: OrdersService,
    private readonly performances: PerformancesService,
    private readonly seats: SeatsService,
    private readonly zones: ZonesService,
    private readonly tickets: TicketsService,
    private readonly release: ReleaseService,
    private readonly refunds: RefundsService,
    private readonly config: AppConfigService,
  ) {}

  /** Step 1: a payment row and the URL of the gateway's payment page. */
  async checkout(
    userId: string,
    orderId: string,
    providerName: string | undefined,
    clientIp: string,
  ): Promise<CheckoutResponseDto> {
    const provider = this.providers.get(
      providerName ?? this.providers.defaultName,
    );
    const order = await this.orders.findOwned(userId, orderId);
    if (!order) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.ORDER_NOT_FOUND,
        'Order not found',
      );
    }
    if (order.status !== 'PENDING') {
      throw notAllowed(
        `Only a PENDING order can be paid (this one is ${order.status})`,
      );
    }
    if (order.expiresAt <= new Date()) {
      throw notAllowed('The hold on this order has ended');
    }
    if (
      (await this.performances.statusOf(order.performanceId)) === 'CANCELLED'
    ) {
      throw notAllowed('This performance has been cancelled');
    }

    // The id is generated first because the gateway reference derives from
    // it: uuidv7 without dashes, 32 characters, unique (vnp_TxnRef).
    const [{ id }] = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT uuidv7()::text AS id
    `;
    const txnRef = txnRefOf(id);
    await this.prisma.payment.create({
      data: {
        id,
        orderId: order.id,
        provider: provider.name,
        txnRef,
        amount: order.totalAmount,
      },
    });
    return {
      paymentId: id,
      provider: provider.name,
      checkoutUrl: provider.checkoutUrl({
        paymentId: id,
        txnRef,
        amountVnd: order.totalAmount,
        orderInfo: `Thanh toan ve Questa ${txnRef}`,
        clientIp,
        // The gateway stops taking money when the hold ends.
        expiresAt: order.expiresAt,
      }),
      expiresAt: order.expiresAt,
    };
  }

  /**
   * Steps 2-7. Never throws: an unexpected error answers 99, which makes
   * VNPay try again later; everything below is safe to repeat.
   */
  async handleIpn(
    providerName: string,
    query: Record<string, unknown>,
  ): Promise<IpnResponse> {
    try {
      return await this.applyIpn(providerName, query);
    } catch (error) {
      this.logger.error(
        `IPN from ${providerName} failed: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return IpnReply.UNKNOWN_ERROR;
    }
  }

  private async applyIpn(
    providerName: string,
    query: Record<string, unknown>,
  ): Promise<IpnResponse> {
    // Step 2: nothing is read or written before the signature checks out.
    const provider = this.providers.find(providerName);
    const callback = provider?.readVerifiedCallback(query) ?? null;
    if (!provider || !callback) {
      this.logger.warn(
        `Rejected an IPN with a bad signature (${providerName})`,
      );
      return IpnReply.INVALID_SIGNATURE;
    }
    const payment = await this.findPayment(provider, callback.txnRef);
    if (!payment) {
      return IpnReply.ORDER_NOT_FOUND;
    }
    // Step 4 (I12): the amount must be exactly what the order costs.
    if (callback.amountVnd !== payment.amount) {
      this.logger.warn(
        `IPN for ${callback.txnRef} carries ${callback.amountVnd} VND, expected ${payment.amount}`,
      );
      return IpnReply.INVALID_AMOUNT;
    }
    // Step 3: this payment was already settled (a re-delivered IPN).
    if (payment.status !== 'PENDING') {
      return IpnReply.ALREADY_CONFIRMED;
    }
    if (!callback.success) {
      return this.recordFailure(payment, callback, query);
    }

    const settlement = await this.settle(payment, callback, query);
    // Redis and BullMQ only after the commit (ADR-0010).
    await this.release.afterCommit(settlement.released);
    if (settlement.refundId) {
      await this.refunds.enqueue([settlement.refundId]);
    }
    return settlement.outcome === 'duplicate'
      ? IpnReply.ALREADY_CONFIRMED
      : IpnReply.CONFIRMED;
  }

  /** The customer gave up or the bank refused: the order stays PENDING. */
  private async recordFailure(
    payment: PaymentRow,
    callback: CallbackResult,
    query: Record<string, unknown>,
  ): Promise<IpnResponse> {
    const changed = await this.prisma.$executeRaw`
      UPDATE payments
      SET status = 'FAILED', raw_payload = ${JSON.stringify(query)}::jsonb,
          updated_at = now()
      WHERE id = ${payment.id}::uuid AND status = 'PENDING'
    `;
    this.logger.log(
      `Payment ${callback.txnRef} failed at the gateway (code ${callback.responseCode})`,
    );
    return changed === 1 ? IpnReply.CONFIRMED : IpnReply.ALREADY_CONFIRMED;
  }

  /** Steps 3, 5 and 6 in one transaction. */
  private async settle(
    payment: PaymentRow,
    callback: CallbackResult,
    query: Record<string, unknown>,
  ): Promise<Settlement> {
    const grace = this.config.get('PAYMENT_GRACE_SECONDS');
    try {
      return await this.prisma.$transaction(async (tx) => {
        // I4: the payment row moves PENDING -> SUCCEEDED once. Of two
        // copies of the same IPN arriving together, the second waits on this
        // row and then matches nothing. The unique provider_txn_id stops the
        // same gateway transaction from being applied to another payment.
        const claimed = await tx.$executeRaw`
          UPDATE payments
          SET status = 'SUCCEEDED', provider_txn_id = ${callback.providerTxnId},
              paid_at = now(), raw_payload = ${JSON.stringify(query)}::jsonb,
              updated_at = now()
          WHERE id = ${payment.id}::uuid AND status = 'PENDING'
        `;
        if (claimed === 0) {
          return { outcome: 'duplicate', released: null, refundId: null };
        }

        // Lock order: the order row (FOR UPDATE), then the performance row
        // (FOR SHARE). Expiry, cancellation and other payments of this order
        // wait for us; cancelling the performance waits too.
        const order = await this.orders.lockForPayment(tx, payment.orderId);
        if (!order) throw new Error(`Order ${payment.orderId} is missing`);
        const performance = await this.performances.lockStatus(
          tx,
          order.performanceId,
        );
        const cancelled = performance === 'CANCELLED';

        // Step 5: still PENDING and within expires_at + grace.
        if (order.status === 'PENDING' && !cancelled) {
          const items = await this.orders.markPaid(tx, order.id, grace);
          if (items) {
            await this.fulfil(tx, items);
            return { outcome: 'paid', released: null, refundId: null };
          }
        }

        // Step 6: the money arrived but the order cannot be fulfilled. Close
        // it if it is still PENDING (late or performance cancelled), never
        // take seats back from a closed order, and refund (I8).
        let released: ReleasedSet | null = null;
        if (order.status === 'PENDING') {
          released = await this.release.releaseInTx(
            tx,
            order.id,
            cancelled
              ? { to: 'CANCELLED' }
              : { to: 'EXPIRED', graceSeconds: grace },
          );
        }
        // Only an EXPIRED/CANCELLED order changes; one already PAID by
        // another payment stays PAID and just gets this money back.
        await this.orders.markRefundPending(tx, order.id);
        const reason = cancelled
          ? 'Performance cancelled'
          : order.status === 'PAID'
            ? 'Order already paid by another payment'
            : 'Payment arrived after the order was closed';
        const refundId = await this.refunds.create(
          tx,
          payment.id,
          payment.amount,
          reason,
        );
        this.logger.warn(
          `Payment ${callback.txnRef} will be refunded: ${reason}`,
        );
        return { outcome: 'refund', released, refundId };
      });
    } catch (error) {
      if (isPgError(error, '23505', 'payments_provider_txn_id_key')) {
        // This gateway transaction was already applied to a payment (I4).
        return { outcome: 'duplicate', released: null, refundId: null };
      }
      throw error;
    }
  }

  /** PAID: seats SOLD, standing counters held -> sold, one ticket per item. */
  private async fulfil(
    tx: Prisma.TransactionClient,
    items: PaidItem[],
  ): Promise<void> {
    const seatIds = items.flatMap((i) => (i.seatId ? [i.seatId] : []));
    const sold = await this.seats.markSold(tx, seatIds);
    if (sold !== seatIds.length) {
      // A held seat of this order is not HELD: selling would break I2.
      // Rolling back answers 99 and the IPN is retried; this must never happen.
      throw new Error(
        `Only ${sold} of ${seatIds.length} seats could be marked SOLD`,
      );
    }
    await this.tickets.issue(
      tx,
      items.map((i) => i.id),
    );
    // The standing counters last: every hold and payment of the zone updates
    // that one row, so its lock is kept only until the commit right after
    // (same rule as holds, ADR-0008).
    const perZone = new Map<string, number>();
    for (const item of items) {
      if (!item.seatId) {
        perZone.set(item.zoneId, (perZone.get(item.zoneId) ?? 0) + 1);
      }
    }
    for (const [zoneId, quantity] of perZone) {
      if (!(await this.zones.sellStanding(tx, zoneId, quantity))) {
        throw new Error(`Zone ${zoneId} holds fewer than ${quantity} tickets`);
      }
    }
  }

  /**
   * The browser comes back from the gateway. Only reports what is known;
   * the order changes state through the IPN alone (flow B, step 2).
   */
  async describeReturn(
    providerName: string,
    query: Record<string, unknown>,
  ): Promise<PaymentReturnResponseDto> {
    const provider = this.providers.find(providerName);
    const callback = provider?.readVerifiedCallback(query) ?? null;
    if (!provider || !callback) {
      return {
        verified: false,
        gatewaySaysSuccess: false,
        responseCode: null,
        orderId: null,
        orderStatus: null,
        paymentStatus: null,
      };
    }
    const payment = await this.prisma.payment.findUnique({
      where: { txnRef: callback.txnRef },
      select: {
        orderId: true,
        status: true,
        order: { select: { status: true } },
      },
    });
    return {
      verified: true,
      gatewaySaysSuccess: callback.success,
      responseCode: callback.responseCode,
      orderId: payment?.orderId ?? null,
      orderStatus: payment?.order.status ?? null,
      paymentStatus: payment?.status ?? null,
    };
  }

  /** The fake gateway's payment page, as data. */
  async fakeCheckout(txnRef: string): Promise<FakeCheckoutResponseDto> {
    const fake = this.providers.get('fake');
    const payment = await this.findPaymentOrThrow(fake, txnRef);
    return {
      txnRef,
      amount: payment.amount,
      orderId: payment.orderId,
      paymentStatus: payment.status,
      outcomes: ['success', 'cancelled', 'failed'],
    };
  }

  /**
   * The customer "pays" at the fake gateway: it signs an IPN exactly like
   * VNPay would and delivers it to our own IPN handler. `amount` lets tests
   * send a wrong amount (I12).
   */
  async fakeComplete(
    txnRef: string,
    outcome: FakeOutcome,
    amount?: number,
  ): Promise<FakeCompleteResponseDto> {
    this.providers.get('fake'); // throws unless the fake gateway is enabled
    const fake = this.providers.fake;
    const payment = await this.findPaymentOrThrow(fake, txnRef);
    const query = fake.signedCallback(
      txnRef,
      amount ?? payment.amount,
      outcome,
    );
    const params = Object.fromEntries(new URLSearchParams(query));
    // Like VNPay: deliver again, with backoff, until the merchant answers
    // 00 or 02 (VNPay keeps trying for 5 minutes; the fake one gives up
    // sooner). A 99 under load is then retried instead of lost.
    let ipn = await this.handleIpn(fake.name, params);
    let deliveries = 1;
    while (
      !FINAL_IPN_CODES.has(ipn.RspCode) &&
      deliveries < FAKE_IPN_DELIVERIES
    ) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (deliveries - 1)));
      ipn = await this.handleIpn(fake.name, params);
      deliveries += 1;
    }
    const base = this.config.get('PUBLIC_BASE_URL');
    return {
      ipn,
      deliveries,
      returnUrl: `${base}/checkout/result/fake?${query}`,
    };
  }

  private findPayment(
    provider: PaymentProvider,
    txnRef: string,
  ): Promise<PaymentRow | null> {
    return this.prisma.payment.findFirst({
      where: { txnRef, provider: provider.name },
      select: paymentRow,
    });
  }

  private async findPaymentOrThrow(
    provider: PaymentProvider,
    txnRef: string,
  ): Promise<PaymentRow> {
    const payment = await this.findPayment(provider, txnRef);
    if (!payment) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.PAYMENT_NOT_FOUND,
        'Payment not found',
      );
    }
    return payment;
  }
}

function notAllowed(message: string): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    ErrorCode.PAYMENT_NOT_ALLOWED,
    message,
  );
}
