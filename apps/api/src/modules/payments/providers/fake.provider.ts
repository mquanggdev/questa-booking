import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service.js';
import type {
  CheckoutInput,
  PaymentProvider,
  RefundInput,
} from './payment-provider.js';
import {
  readCallback,
  signedQuery,
  verify,
  vnpDate,
  type CallbackResult,
  type VnpParams,
} from './vnpay-protocol.js';

export type FakeOutcome = 'success' | 'cancelled' | 'failed';

/**
 * A local gateway speaking the VNPay protocol (same parameters, same
 * HMAC-SHA512 signatures) with its own secret. Tests, load tests and the demo
 * use it so they never depend on the real sandbox. Refused in production
 * unless ALLOW_FAKE_PAYMENTS is set (env.schema.ts).
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  /** Test hook: make the next refunds fail, to exercise retries and the DLQ. */
  failRefunds = false;

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return (
      this.config.get('NODE_ENV') !== 'production' ||
      this.config.get('ALLOW_FAKE_PAYMENTS')
    );
  }

  private get secret(): string {
    return this.config.get('FAKE_PAYMENT_SECRET');
  }

  checkoutUrl(input: CheckoutInput): string {
    const base = this.config.get('PUBLIC_BASE_URL');
    return `${base}/api/v1/payments/fake/checkout?txnRef=${input.txnRef}`;
  }

  readVerifiedCallback(query: Record<string, unknown>): CallbackResult | null {
    return verify(query, this.secret) ? readCallback(query) : null;
  }

  /**
   * What the gateway would send to our IPN endpoint once the customer has
   * paid (or given up), signed like VNPay signs it.
   */
  signedCallback(
    txnRef: string,
    amountVnd: number,
    outcome: FakeOutcome,
    // 14-15 digits: across thousands of load-test payments, two random
    // numbers must not collide (that would look like one transaction).
    transactionNo: string = String(randomInt(1e14, 2 ** 48 - 1)),
  ): string {
    const codes: Record<FakeOutcome, [string, string]> = {
      success: ['00', '00'],
      cancelled: ['24', '02'], // customer cancelled at the gateway
      failed: ['51', '02'], // insufficient funds
    };
    const [responseCode, transactionStatus] = codes[outcome];
    const params: VnpParams = {
      vnp_TmnCode: 'FAKE0001',
      vnp_TxnRef: txnRef,
      vnp_Amount: String(amountVnd * 100),
      vnp_BankCode: 'NCB',
      vnp_PayDate: vnpDate(new Date()),
      vnp_ResponseCode: responseCode,
      vnp_TransactionStatus: transactionStatus,
      vnp_TransactionNo: transactionNo,
      vnp_OrderInfo: `Thanh toan ${txnRef}`,
    };
    return signedQuery(params, this.secret);
  }

  refund(input: RefundInput): Promise<string> {
    if (this.failRefunds) {
      return Promise.reject(
        new Error('fake gateway: refund temporarily unavailable'),
      );
    }
    return Promise.resolve(`fake-refund-${input.refundId}`);
  }
}
