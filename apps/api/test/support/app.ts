import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Role } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { Redis } from 'ioredis';

// Points at the test Redis database (REDIS_URL from vitest.config.e2e.ts).
export const testRedis = new Redis(process.env.REDIS_URL ?? '', {
  lazyConnect: true,
});

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: false,
  });
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      testRedis.disconnect();
    },
  };
}

/**
 * Empties every application table (migrations history is kept) and the test
 * Redis database (gate keys, queued jobs), so tests never see each other's state.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await testRedis.flushdb();
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export const TEST_PASSWORD = 'correct-horse-battery';
let passwordHash: Promise<string> | undefined;

let counter = 0;

/** Inserts a user directly (any role) and logs in through the API. */
export async function createUserAndLogin(
  t: TestApp,
  role: Role = Role.CUSTOMER,
): Promise<{ id: string; email: string; accessToken: string; cookie: string }> {
  passwordHash ??= argon2.hash(TEST_PASSWORD);
  counter += 1;
  const email = `${role.toLowerCase()}-${counter}-${Date.now()}@test.local`;
  const user = await t.prisma.user.create({
    data: {
      email,
      passwordHash: await passwordHash,
      fullName: `${role} ${counter}`,
      role,
    },
  });
  const res = await t
    .http()
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  const body = res.body as { accessToken: string };
  return {
    id: user.id,
    email,
    accessToken: body.accessToken,
    cookie: refreshCookie(res.headers['set-cookie']),
  };
}

/** Extracts "refresh_token=<value>" from a Set-Cookie header. */
export function refreshCookie(setCookie: unknown): string {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const found = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith('refresh_token='),
  );
  if (!found) {
    throw new Error('No refresh_token cookie in response');
  }
  return found.split(';')[0] ?? '';
}
