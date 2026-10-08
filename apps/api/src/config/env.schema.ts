import { z } from 'zod';

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    // Human-readable logs for local runs; containers always emit JSON.
    LOG_PRETTY: z.stringbool().default(false),
    DATABASE_URL: z.url(),
    // Connections per process. PostgreSQL allows 100 in total; leave room for
    // other API instances, the worker, and migrations.
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    // How long a transaction may wait for a free connection before the request
    // is rejected with 503 (load shedding instead of an unbounded queue).
    DB_TX_MAX_WAIT_MS: z.coerce.number().int().positive().default(2000),
    DB_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    REDIS_URL: z.url(),

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    // Secure cookies need HTTPS; off for local HTTP, on behind TLS in production.
    COOKIE_SECURE: z.stringbool().default(false),
    SWAGGER_ENABLED: z.stringbool().default(true),
    // How long a reservation holds its tickets before the order expires.
    HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // Extra time after expires_at before an unpaid order is released, so a
    // payment confirmed in the last seconds still finds its order (phase 5).
    PAYMENT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(120),
    // Redis filter in front of the database (phase 4). Off = phase 3 behaviour.
    RESERVATION_GATE_ENABLED: z.stringbool().default(true),
    // Worker schedules: safety-net sweep of overdue orders, Redis counter repair.
    SWEEP_EVERY_MS: z.coerce.number().int().positive().default(60_000),
    RECONCILE_EVERY_MS: z.coerce.number().int().positive().default(30_000),
    // Payments (phase 5). "fake" speaks the VNPay protocol against a local
    // simulated gateway; it is refused in production.
    PAYMENT_PROVIDER: z.enum(['fake', 'vnpay']).default('fake'),
    // Public origin of the site (web app at /, API at /api): browsers are
    // sent back here and the gateway calls the IPN at /api/v1/payments/ipn.
    PUBLIC_BASE_URL: z.url().default('http://localhost:3200'),
    // The local Docker stack runs with NODE_ENV=production but still needs the
    // fake gateway for load tests: it must be allowed explicitly. Never set on
    // a public deployment.
    ALLOW_FAKE_PAYMENTS: z.stringbool().default(false),
    FAKE_PAYMENT_SECRET: z
      .string()
      .min(16)
      .default('local-fake-gateway-secret'),
    VNPAY_TMN_CODE: optionalText,
    VNPAY_HASH_SECRET: optionalText,
    VNPAY_URL: z
      .url()
      .default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
    VNPAY_API_URL: z
      .url()
      .default('https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'),
    REFUND_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    // How numbered seats are locked when held. All three are correct; they are
    // kept side by side so the benchmark can compare them (ADR-0008).
    SEAT_HOLD_STRATEGY: z
      .enum(['conditional', 'pessimistic', 'optimistic'])
      .default('conditional'),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      env.PAYMENT_PROVIDER === 'fake' &&
      !env.ALLOW_FAKE_PAYMENTS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message:
          'the fake payment gateway is not allowed in production (set ALLOW_FAKE_PAYMENTS=true only for local load tests)',
      });
    }
    if (
      env.PAYMENT_PROVIDER === 'vnpay' &&
      (!env.VNPAY_TMN_CODE || !env.VNPAY_HASH_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['VNPAY_TMN_CODE'],
        message:
          'VNPAY_TMN_CODE and VNPAY_HASH_SECRET are required for PAYMENT_PROVIDER=vnpay',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
