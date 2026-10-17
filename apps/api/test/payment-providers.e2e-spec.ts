import { createTestApp, type TestApp } from './support/app.js';

const VNPAY = {
  VNPAY_TMN_CODE: 'TESTCODE',
  VNPAY_HASH_SECRET: 'TESTSECRETTESTSECRETTESTSECRET12',
};

/**
 * The web app shows one payment button per enabled gateway: VNPay once its
 * merchant code is set, the fake gateway where it is allowed. The default
 * (PAYMENT_PROVIDER) comes first.
 */
describe('Payment providers (e2e)', () => {
  let fakeOnly: TestApp;
  let both: TestApp;
  let vnpayFirst: TestApp;

  beforeAll(async () => {
    [fakeOnly, both, vnpayFirst] = await Promise.all([
      createTestApp(),
      createTestApp({ config: VNPAY }),
      createTestApp({ config: { ...VNPAY, PAYMENT_PROVIDER: 'vnpay' } }),
    ]);
  });

  afterAll(async () => {
    for (const app of [vnpayFirst, both, fakeOnly]) await app.close();
  });

  const available = async (app: TestApp) =>
    (await app.http().get('/api/v1/payments/providers').expect(200)).body
      .available as string[];

  it('lists only the fake gateway while VNPay has no merchant code', async () => {
    expect(await available(fakeOnly)).toEqual(['fake']);
  });

  it('adds VNPay once it is configured, after the default', async () => {
    expect(await available(both)).toEqual(['fake', 'vnpay']);
  });

  it('puts the default gateway first', async () => {
    expect(await available(vnpayFirst)).toEqual(['vnpay', 'fake']);
  });
});
