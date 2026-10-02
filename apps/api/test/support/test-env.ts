// Derives an isolated environment for e2e tests from the developer's .env
// (or CI variables): same PostgreSQL server but a separate "<db>_test"
// database, and Redis logical database 1. Tests can wipe both freely without
// touching seeded development data.

try {
  process.loadEnvFile('../../.env');
} catch {
  // CI provides variables directly.
}

function withDatabase(url: string, suffix: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith(suffix)) {
    parsed.pathname = `/${name}${suffix}`;
  }
  return parsed.toString();
}

function withRedisDb(url: string, db: number): string {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

const baseDatabaseUrl = process.env.DATABASE_URL;
const baseRedisUrl = process.env.REDIS_URL;
if (!baseDatabaseUrl || !baseRedisUrl) {
  throw new Error('DATABASE_URL and REDIS_URL must be set for e2e tests');
}

export const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  LOG_PRETTY: 'false',
  DATABASE_URL: withDatabase(baseDatabaseUrl, '_test'),
  REDIS_URL: withRedisDb(baseRedisUrl, 1),
  JWT_ACCESS_SECRET: 'e2e-test-secret-that-is-long-enough-123456',
  JWT_ACCESS_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '7',
  COOKIE_SECURE: 'false',
  SWAGGER_ENABLED: 'false',
} satisfies Record<string, string>;
