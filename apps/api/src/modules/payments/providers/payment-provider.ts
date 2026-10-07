import type { CallbackResult } from './vnpay-protocol.js';

export type ProviderName = 'vnpay' | 'fake';

export interface CheckoutInput {
  paymentId: string;
  txnRef: string;
  amountVnd: number;
  orderInfo: string;
  clientIp: string;
  /** The gateway refuses to take money after this (the hold's expires_at). */
  expiresAt: Date;
}

export interface RefundInput {
  refundId: string;
  txnRef: string;
  amountVnd: number;
  providerTxnId: string;
  /** vnp_PayDate of the original payment. */
  payDate: string;
  reason: string;
}

/** Thrown when a refund can never succeed (no point retrying). */
export class PermanentRefundError extends Error {}

/**
 * A payment gateway. Both implementations speak the VNPay protocol; the fake
 * one points at a local simulated gateway so tests and load tests never touch
 * the real sandbox (spec, section 9).
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  /** URL the customer's browser is sent to in order to pay. */
  checkoutUrl(input: CheckoutInput): string;
  /** Verified callback (IPN or return URL), or null if the signature is wrong. */
  readVerifiedCallback(query: Record<string, unknown>): CallbackResult | null;
  /**
   * Asks the gateway to give the money back. Resolves with the gateway's
   * refund reference; throws to be retried, or PermanentRefundError to stop.
   */
  refund(input: RefundInput): Promise<string>;
}
