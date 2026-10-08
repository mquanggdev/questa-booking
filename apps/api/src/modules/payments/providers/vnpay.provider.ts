import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';
import {
  PermanentRefundError,
  type CheckoutInput,
  type PaymentProvider,
  type RefundInput,
} from './payment-provider.js';
import {
  paymentParams,
  readCallback,
  refundBody,
  signedQuery,
  verify,
  type CallbackResult,
} from './vnpay-protocol.js';

// Refund answers worth retrying: duplicate request within the API's time
// window (94) and "other error" (99). Anything else is final.
const RETRYABLE_REFUND_CODES = new Set(['94', '99']);

/** The real VNPay sandbox. Enabled when VNPAY_TMN_CODE and VNPAY_HASH_SECRET are set. */
@Injectable()
export class VnpayProvider implements PaymentProvider {
  readonly name = 'vnpay' as const;
  private readonly logger = new Logger(VnpayProvider.name);

  constructor(private readonly config: AppConfigService) {}

  get configured(): boolean {
    return Boolean(
      this.config.get('VNPAY_TMN_CODE') && this.config.get('VNPAY_HASH_SECRET'),
    );
  }

  private get secret(): string {
    return this.config.get('VNPAY_HASH_SECRET') ?? '';
  }

  checkoutUrl(input: CheckoutInput): string {
    const params = paymentParams({
      tmnCode: this.config.get('VNPAY_TMN_CODE') ?? '',
      txnRef: input.txnRef,
      amountVnd: input.amountVnd,
      orderInfo: input.orderInfo,
      // The web app's result page; it asks GET /payments/return/vnpay what
      // the redirect means. Only the IPN changes the order.
      returnUrl: `${this.config.get('PUBLIC_BASE_URL')}/checkout/result/vnpay`,
      clientIp: input.clientIp,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    });
    return `${this.config.get('VNPAY_URL')}?${signedQuery(params, this.secret)}`;
  }

  readVerifiedCallback(query: Record<string, unknown>): CallbackResult | null {
    return verify(query, this.secret) ? readCallback(query) : null;
  }

  async refund(input: RefundInput): Promise<string> {
    const body = refundBody(
      {
        // Unique per request and per day; the refund id fits in 32 characters.
        requestId: input.refundId.replace(/-/g, ''),
        tmnCode: this.config.get('VNPAY_TMN_CODE') ?? '',
        txnRef: input.txnRef,
        amountVnd: input.amountVnd,
        transactionNo: input.providerTxnId,
        transactionDate: input.payDate,
        createBy: 'questa-booking',
        createdAt: new Date(),
        ipAddr: '127.0.0.1',
        orderInfo: input.reason,
      },
      this.secret,
    );
    const res = await fetch(this.config.get('VNPAY_API_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`VNPay refund HTTP ${res.status}`);
    }
    const reply = (await res.json()) as Record<string, string>;
    const code = reply.vnp_ResponseCode ?? '';
    if (code === '00') {
      return reply.vnp_TransactionNo ?? reply.vnp_ResponseId ?? input.refundId;
    }
    this.logger.warn(
      `VNPay refund ${input.refundId} answered ${code}: ${reply.vnp_Message}`,
    );
    if (RETRYABLE_REFUND_CODES.has(code)) {
      throw new Error(`VNPay refund code ${code}`);
    }
    throw new PermanentRefundError(
      `VNPay refused the refund (code ${code}: ${reply.vnp_Message})`,
    );
  }
}
