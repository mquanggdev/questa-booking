import { validateEnv } from './env.schema.js';

const valid = {
  DATABASE_URL: 'postgresql://questa:questa@localhost:5432/questa',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults and coerces numbers and booleans', () => {
    const env = validateEnv({ ...valid, PORT: '4000', COOKIE_SECURE: 'true' });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('refuses the fake payment gateway in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'fake',
      }),
    ).toThrow(/fake payment gateway/);
    expect(
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'fake',
        ALLOW_FAKE_PAYMENTS: 'true',
      }).PAYMENT_PROVIDER,
    ).toBe('fake');
  });

  it('requires VNPay credentials when VNPay is the provider', () => {
    expect(() => validateEnv({ ...valid, PAYMENT_PROVIDER: 'vnpay' })).toThrow(
      /VNPAY_TMN_CODE/,
    );
    expect(
      validateEnv({
        ...valid,
        PAYMENT_PROVIDER: 'vnpay',
        VNPAY_TMN_CODE: 'ABCD1234',
        VNPAY_HASH_SECRET: 'x'.repeat(32),
      }).PAYMENT_PROVIDER,
    ).toBe('vnpay');
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_ACCESS_SECRET: 'too-short' }),
    ).toThrow(/at least 32 characters/);
  });
});
