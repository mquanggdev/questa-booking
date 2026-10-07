import { createHmac, timingSafeEqual } from 'node:crypto';

// The VNPay 2.1.0 wire protocol: building signed payment URLs, verifying IPN
// and return-URL callbacks, and signing refund requests. Pure functions, so
// the real gateway and the local fake gateway share exactly the same code.
// Reference: https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html

export type VnpParams = Record<string, string>;

/**
 * VNPay's reference implementation encodes each value with
 * encodeURIComponent and turns "%20" into "+" before hashing. The signature
 * only matches if we encode exactly the same way.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/** "a=1&b=2" over the keys sorted ascending, values encoded as above. */
export function canonicalQuery(params: VnpParams): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key] ?? '')}`)
    .join('&');
}

export function hmacSha512(secret: string, data: string): string {
  return createHmac('sha512', secret).update(data, 'utf8').digest('hex');
}

export function sign(params: VnpParams, secret: string): string {
  return hmacSha512(secret, canonicalQuery(params));
}

/** The signed query string to append to the gateway URL. */
export function signedQuery(params: VnpParams, secret: string): string {
  return `${canonicalQuery(params)}&vnp_SecureHash=${sign(params, secret)}`;
}

/**
 * Checks vnp_SecureHash on a callback. vnp_SecureHash and vnp_SecureHashType
 * are not part of the signed data. Compared in constant time so the check
 * leaks nothing about how many leading characters matched.
 */
export function verify(
  query: Record<string, unknown>,
  secret: string,
): boolean {
  const received =
    typeof query.vnp_SecureHash === 'string' ? query.vnp_SecureHash : '';
  const params: VnpParams = {};
  for (const [key, value] of Object.entries(query)) {
    if (
      !key.startsWith('vnp_') ||
      key === 'vnp_SecureHash' ||
      key === 'vnp_SecureHashType'
    ) {
      continue;
    }
    if (typeof value !== 'string') return false; // duplicated or nested params
    params[key] = value;
  }
  const expected = sign(params, secret);
  const a = Buffer.from(received.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** yyyyMMddHHmmss in GMT+7, the only time format VNPay accepts. */
export function vnpDate(date: Date): string {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}` +
    `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())}`
  );
}

/** vnp_TxnRef: alphanumeric, so the payment UUID without its dashes. */
export function txnRefOf(paymentId: string): string {
  return paymentId.replace(/-/g, '');
}

/**
 * VNPay requires unaccented text without special characters. NFD splits
 * "á" into "a" + accent, but "đ" is its own letter and must be mapped.
 */
export function unaccent(text: string): string {
  return text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/ +/g, ' ')
    .trim();
}

export interface PaymentRequest {
  tmnCode: string;
  txnRef: string;
  amountVnd: number;
  orderInfo: string;
  returnUrl: string;
  clientIp: string;
  createdAt: Date;
  expiresAt: Date;
}

/** The vnp_* parameters of a "pay" request (unsigned). */
export function paymentParams(req: PaymentRequest): VnpParams {
  return {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: req.tmnCode,
    vnp_Locale: 'vn',
    vnp_CurrCode: 'VND',
    vnp_TxnRef: req.txnRef,
    // VNPay requires unaccented text without special characters.
    vnp_OrderInfo: unaccent(req.orderInfo),
    vnp_OrderType: 'other',
    // Amount in VND x 100 (VNPay's "no decimals" convention).
    vnp_Amount: String(req.amountVnd * 100),
    vnp_ReturnUrl: req.returnUrl,
    vnp_IpAddr: req.clientIp,
    vnp_CreateDate: vnpDate(req.createdAt),
    vnp_ExpireDate: vnpDate(req.expiresAt),
  };
}

export interface CallbackResult {
  txnRef: string;
  /** VND (vnp_Amount / 100). */
  amountVnd: number;
  /** vnp_ResponseCode and vnp_TransactionStatus both "00". */
  success: boolean;
  /** VNPay's transaction number (vnp_TransactionNo). */
  providerTxnId: string;
  /** vnp_PayDate, needed later to request a refund. */
  payDate: string;
  responseCode: string;
}

/** Reads a verified callback. Returns null when required fields are missing. */
export function readCallback(
  query: Record<string, unknown>,
): CallbackResult | null {
  const field = (key: string) =>
    typeof query[key] === 'string' ? (query[key] as string) : '';
  const amount = Number(field('vnp_Amount'));
  if (!field('vnp_TxnRef') || !Number.isInteger(amount) || amount <= 0) {
    return null;
  }
  return {
    txnRef: field('vnp_TxnRef'),
    amountVnd: amount / 100,
    success:
      field('vnp_ResponseCode') === '00' &&
      field('vnp_TransactionStatus') === '00',
    providerTxnId: field('vnp_TransactionNo'),
    payDate: field('vnp_PayDate'),
    responseCode: field('vnp_ResponseCode'),
  };
}

export interface RefundRequest {
  requestId: string;
  tmnCode: string;
  txnRef: string;
  amountVnd: number;
  transactionNo: string;
  transactionDate: string;
  createBy: string;
  createdAt: Date;
  ipAddr: string;
  orderInfo: string;
}

/**
 * Body of a full refund request (vnp_Command=refund, type 02). Its checksum is
 * NOT the sorted query string: it is these 13 fields joined by "|", in this
 * exact order (VNPay "querydr & refund" documentation).
 */
export function refundBody(
  req: RefundRequest,
  secret: string,
): Record<string, string> {
  const body = {
    vnp_RequestId: req.requestId,
    vnp_Version: '2.1.0',
    vnp_Command: 'refund',
    vnp_TmnCode: req.tmnCode,
    vnp_TransactionType: '02',
    vnp_TxnRef: req.txnRef,
    vnp_Amount: String(req.amountVnd * 100),
    vnp_TransactionNo: req.transactionNo,
    vnp_TransactionDate: req.transactionDate,
    vnp_CreateBy: req.createBy,
    vnp_CreateDate: vnpDate(req.createdAt),
    vnp_IpAddr: req.ipAddr,
    vnp_OrderInfo: unaccent(req.orderInfo),
  };
  const data = [
    body.vnp_RequestId,
    body.vnp_Version,
    body.vnp_Command,
    body.vnp_TmnCode,
    body.vnp_TransactionType,
    body.vnp_TxnRef,
    body.vnp_Amount,
    body.vnp_TransactionNo,
    body.vnp_TransactionDate,
    body.vnp_CreateBy,
    body.vnp_CreateDate,
    body.vnp_IpAddr,
    body.vnp_OrderInfo,
  ].join('|');
  return { ...body, vnp_SecureHash: hmacSha512(secret, data) };
}

/** IPN answers, from the VNPay IPN documentation. 00 and 02 stop retries. */
export const IpnReply = {
  CONFIRMED: { RspCode: '00', Message: 'Confirm Success' },
  ORDER_NOT_FOUND: { RspCode: '01', Message: 'Order not found' },
  ALREADY_CONFIRMED: { RspCode: '02', Message: 'Order already confirmed' },
  INVALID_AMOUNT: { RspCode: '04', Message: 'Invalid amount' },
  INVALID_SIGNATURE: { RspCode: '97', Message: 'Invalid signature' },
  UNKNOWN_ERROR: { RspCode: '99', Message: 'Unknown error' },
} as const;

export type IpnReply = (typeof IpnReply)[keyof typeof IpnReply];
