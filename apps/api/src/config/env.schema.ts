import { z } from 'zod';

export const envSchema = z.object({
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
