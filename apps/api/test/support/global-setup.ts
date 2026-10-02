import { execSync } from 'node:child_process';
import pg from 'pg';
import { testEnv } from './test-env.js';

// Runs once before all e2e files: create the test database if needed and
// bring its schema up to date with the same migrations production uses.
export default async function globalSetup(): Promise<void> {
  const target = new URL(testEnv.DATABASE_URL);
  const dbName = target.pathname.replace(/^\//, '');
  const admin = new URL(testEnv.DATABASE_URL);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (exists.rowCount === 0) {
      // Identifiers cannot be bound as parameters; dbName comes from our own config.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    }
  } finally {
    await client.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testEnv.DATABASE_URL },
  });
}
