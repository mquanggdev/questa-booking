import { defineConfig } from 'prisma/config';

// Local runs read the shared .env at the repo root; in containers the
// variables come from the environment and the file does not exist.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the process environment
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
