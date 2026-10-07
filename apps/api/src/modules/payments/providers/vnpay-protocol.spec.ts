import { createHmac } from 'node:crypto';
import {
  canonicalQuery,
  paymentParams,
  readCallback,
  refundBody,
  sign,
  signedQuery,
  txnRefOf,
  verify,
  vnpDate,
} from './vnpay-protocol.js';

const SECRET = 'TESTSECRETTESTSECRETTESTSECRET12';

describe('VNPay protocol', () => {
  it('formats dates in GMT+7 as yyyyMMddHHmmss', () => {
    // 2026-10-08 17:30:05 UTC is 2026-10-09 00:30:05 in Vietnam.
    expect(vnpDate(new Date('2026-10-08T17:30:05Z'))).toBe('20261009003005');
  });

  it('sorts keys and encodes values like the VNPay sample (space as +)', () => {
    expect(canonicalQuery({ vnp_b: 'x y', vnp_a: 'http://h/r?q=1' })).toBe(
      'vnp_a=http%3A%2F%2Fh%2Fr%3Fq%3D1&vnp_b=x+y',
    );
  });

  it('signs with HMAC-SHA512 over the canonical query', () => {
    const params = { vnp_Amount: '100000', vnp_TxnRef: 'abc' };
    const expected = createHmac('sha512', SECRET)
      .update('vnp_Amount=100000&vnp_TxnRef=abc')
      .digest('hex');
    expect(sign(params, SECRET)).toBe(expected);
  });

  it('builds payment params: amount x100, expire date, unaccented order info', () => {
    const params = paymentParams({
      tmnCode: 'TMN00001',
      txnRef: txnRefOf('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'),
      amountVnd: 1_500_000,
      orderInfo: 'Thanh toán đơn #42',
      returnUrl: 'http://localhost/return',
      clientIp: '127.0.0.1',
      createdAt: new Date('2026-10-08T03:00:00Z'),
      expiresAt: new Date('2026-10-08T03:10:00Z'),
    });
    expect(params).toMatchObject({
      vnp_Amount: '150000000',
      vnp_TxnRef: '0190a1b2c3d47e5f8a9b0c1d2e3f4a5b',
      vnp_OrderInfo: 'Thanh toan don 42',
      vnp_CreateDate: '20261008100000',
      vnp_ExpireDate: '20261008101000',
      vnp_Command: 'pay',
      vnp_CurrCode: 'VND',
    });
  });

  it('verifies a correctly signed callback and rejects tampering', () => {
    const callback: Record<string, string> = {
      vnp_TxnRef: 'abc',
      vnp_Amount: '150000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '14123456',
      vnp_PayDate: '20261008101500',
    };
    const query = Object.fromEntries(
      new URLSearchParams(signedQuery(callback, SECRET)),
    );
    expect(verify(query, SECRET)).toBe(true);
    expect(verify({ ...query, vnp_SecureHashType: 'HmacSHA512' }, SECRET)).toBe(
      true,
    );
    expect(verify({ ...query, vnp_Amount: '1' }, SECRET)).toBe(false);
    expect(verify(query, 'another-secret-another-secret-00')).toBe(false);
    expect(verify({ ...query, vnp_SecureHash: undefined }, SECRET)).toBe(false);
    expect(verify({ ...query, vnp_Amount: ['1', '2'] }, SECRET)).toBe(false);
  });

  it('reads a callback: success needs both codes 00', () => {
    const base = {
      vnp_TxnRef: 'abc',
      vnp_Amount: '150000000',
      vnp_TransactionNo: '14123456',
      vnp_PayDate: '20261008101500',
    };
    expect(
      readCallback({
        ...base,
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      }),
    ).toMatchObject({
      amountVnd: 1_500_000,
      success: true,
      providerTxnId: '14123456',
    });
    expect(
      readCallback({
        ...base,
        vnp_ResponseCode: '24',
        vnp_TransactionStatus: '02',
      })?.success,
    ).toBe(false);
    expect(readCallback({ ...base, vnp_Amount: 'abc' })).toBeNull();
  });

  it('signs a refund over the 13 fields joined by "|"', () => {
    const body = refundBody(
      {
        requestId: 'req1',
        tmnCode: 'TMN00001',
        txnRef: 'abc',
        amountVnd: 1_500_000,
        transactionNo: '14123456',
        transactionDate: '20261008101500',
        createBy: 'questa',
        createdAt: new Date('2026-10-08T04:00:00Z'),
        ipAddr: '127.0.0.1',
        orderInfo: 'Hoan tien',
      },
      SECRET,
    );
    const data =
      'req1|2.1.0|refund|TMN00001|02|abc|150000000|14123456|20261008101500|questa|20261008110000|127.0.0.1|Hoan tien';
    expect(body.vnp_SecureHash).toBe(
      createHmac('sha512', SECRET).update(data).digest('hex'),
    );
    expect(body.vnp_TransactionType).toBe('02');
  });
});
