/**
 * Development and load-test data. Wipes every table first, so it refuses to
 * run in production.
 *
 *   pnpm --filter @questa/api db:seed
 *
 * Creates:
 * - 1 organizer, 1 staff, 5,000 customers (password: SEED_PASSWORD)
 * - "Questa Fest 2026": 2 performances x 10,000 tickets
 *   (8,000 numbered seats in VIP / CAT 1 / CAT 2 + 2,000 standing)
 * - "Load Test Night": 100 seats + 500 standing, the k6 contention target
 * - "Questa Arena Live": 10,000 tickets with the virtual waiting room on,
 *   the k6 on-sale target (phase 7b)
 * - "Questa Fan Club Night": in its PRESALE phase, with 50 presale codes
 * - load-tests/data/users.json: customers with long-lived access tokens, so k6
 *   never has to hash 5,000 passwords during setup
 * - load-tests/data/fixtures.json: ids that the k6 scripts target, and the
 *   presale codes (development data, shown on the demo page)
 * - load-tests/data/on-sale.json: the on-sale night's seat ids, kept apart
 *   so the other scenarios do not load 8,000 ids into every virtual user
 */
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PrismaClient,
  Role,
  type SalePhaseType,
  type ZoneType,
} from '../src/generated/prisma/client.js';
import {
  formatPresaleCode,
  newPresaleCode,
} from '../src/modules/concerts/presale-code.js';
import { rowLabel } from '../src/modules/seats/row-label.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CUSTOMER_COUNT = 5000;
const PRESALE_CODE_COUNT = 50;
const OUTPUT_DIR = resolve(import.meta.dirname, '../../../load-tests/data');

interface ZoneSpec {
  name: string;
  type: ZoneType;
  price: number;
  rows?: number;
  seatsPerRow?: number;
  capacity?: number;
}

const STADIUM_ZONES: ZoneSpec[] = [
  { name: 'VIP', type: 'SEATED', price: 3_500_000, rows: 20, seatsPerRow: 50 },
  {
    name: 'CAT 1',
    type: 'SEATED',
    price: 2_000_000,
    rows: 50,
    seatsPerRow: 60,
  },
  {
    name: 'CAT 2',
    type: 'SEATED',
    price: 1_200_000,
    rows: 50,
    seatsPerRow: 80,
  },
  { name: 'GA', type: 'STANDING', price: 800_000, capacity: 2000 },
];

const FAN_CLUB_ZONES: ZoneSpec[] = [
  {
    name: 'FAN ZONE',
    type: 'SEATED',
    price: 1_500_000,
    rows: 10,
    seatsPerRow: 20,
  },
  { name: 'GA', type: 'STANDING', price: 700_000, capacity: 300 },
];

const LOAD_TEST_ZONES: ZoneSpec[] = [
  {
    name: 'TEST SEATED',
    type: 'SEATED',
    price: 1_000_000,
    rows: 5,
    seatsPerRow: 20,
  },
  { name: 'TEST GA', type: 'STANDING', price: 500_000, capacity: 500 },
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production');
  }
  const started = Date.now();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });

  try {
    await wipe(prisma);

    // One hash for every seeded account: argon2 is deliberately slow, and
    // 5,000 distinct hashes would take minutes for no benefit in test data.
    const passwordHash = await argon2.hash(
      process.env.SEED_PASSWORD ?? 'Questa@2026',
    );

    const organizer = await prisma.user.create({
      data: {
        email: 'organizer@questa.test',
        passwordHash,
        fullName: 'Questa Organizer',
        role: Role.ORGANIZER,
      },
    });
    await prisma.user.create({
      data: {
        email: 'staff@questa.test',
        passwordHash,
        fullName: 'Questa Gate Staff',
        role: Role.STAFF,
      },
    });
    await prisma.user.createMany({
      data: Array.from({ length: CUSTOMER_COUNT }, (_, i) => {
        const n = String(i + 1).padStart(4, '0');
        return {
          email: `customer${n}@questa.test`,
          passwordHash,
          fullName: `Customer ${n}`,
        };
      }),
    });

    const now = Date.now();
    const generalSale = (startsAt: Date) => [
      {
        type: 'GENERAL' as SalePhaseType,
        startsAt: new Date(now - HOUR),
        endsAt: new Date(startsAt.getTime() - DAY),
      },
    ];

    const fest = await prisma.concert.create({
      data: {
        organizerId: organizer.id,
        name: 'Questa Fest 2026',
        artist: 'The Questa Collective',
        description: 'Two nights, 20,000 fans. The flagship seeded concert.',
      },
    });
    for (const offset of [30, 31]) {
      const startsAt = new Date(now + offset * DAY);
      await createPerformance(prisma, {
        concertId: fest.id,
        venue: 'My Dinh National Stadium',
        startsAt,
        zones: STADIUM_ZONES,
        salePhases: generalSale(startsAt),
      });
    }

    const lab = await prisma.concert.create({
      data: {
        organizerId: organizer.id,
        name: 'Load Test Night',
        artist: 'k6',
        description:
          'Small inventory that thousands of virtual users fight over.',
      },
    });
    const labStart = new Date(now + 14 * DAY);
    const loadTest = await createPerformance(prisma, {
      concertId: lab.id,
      venue: 'Benchmark Hall',
      startsAt: labStart,
      zones: LOAD_TEST_ZONES,
      salePhases: generalSale(labStart),
    });

    // On-sale target: k6 moves the sale's opening a few seconds into the
    // future before every run, so buyers queue first and then rush in.
    const arena = await prisma.concert.create({
      data: {
        organizerId: organizer.id,
        name: 'Questa Arena Live',
        artist: 'Neon Harbor',
        description:
          'One night, 10,000 tickets, a virtual waiting room in front of the sale.',
      },
    });
    const arenaStart = new Date(now + 45 * DAY);
    const onSale = await createPerformance(prisma, {
      concertId: arena.id,
      venue: 'Phu Tho Indoor Arena',
      startsAt: arenaStart,
      zones: STADIUM_ZONES,
      salePhases: generalSale(arenaStart),
      waitingRoomEnabled: true,
    });

    // Presale running now, general sale in two days.
    const fanClub = await prisma.concert.create({
      data: {
        organizerId: organizer.id,
        name: 'Questa Fan Club Night',
        artist: 'The Questa Collective',
        description:
          'Members first: the presale needs a code from the fan club.',
      },
    });
    const fanStart = new Date(now + 20 * DAY);
    const presale = await createPerformance(prisma, {
      concertId: fanClub.id,
      venue: 'Hoa Binh Theater',
      startsAt: fanStart,
      zones: FAN_CLUB_ZONES,
      salePhases: [
        {
          type: 'PRESALE',
          startsAt: new Date(now - HOUR),
          endsAt: new Date(now + 2 * DAY),
        },
        {
          type: 'GENERAL',
          startsAt: new Date(now + 2 * DAY),
          endsAt: new Date(fanStart.getTime() - DAY),
        },
      ],
    });
    const presalePhase = await prisma.salePhase.findFirstOrThrow({
      where: { performanceId: presale.id, type: 'PRESALE' },
      select: { id: true },
    });
    const codes = Array.from({ length: PRESALE_CODE_COUNT }, () =>
      newPresaleCode(),
    );
    await prisma.presaleCode.createMany({
      data: codes.map((code) => ({ salePhaseId: presalePhase.id, code })),
    });

    await writeLoadTestData(prisma, loadTest, onSale, {
      performanceId: presale.id,
      salePhaseId: presalePhase.id,
      codes: codes.map(formatPresaleCode),
    });

    const seats = await prisma.seat.count();
    console.log(
      `Seeded ${CUSTOMER_COUNT + 2} users, ${seats} seats in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} CASCADE`);
}

async function createPerformance(
  prisma: PrismaClient,
  input: {
    concertId: string;
    venue: string;
    startsAt: Date;
    zones: ZoneSpec[];
    salePhases: { type: SalePhaseType; startsAt: Date; endsAt: Date }[];
    waitingRoomEnabled?: boolean;
  },
): Promise<{
  id: string;
  zones: { id: string; name: string; type: ZoneType }[];
}> {
  const performance = await prisma.performance.create({
    data: {
      concertId: input.concertId,
      venue: input.venue,
      startsAt: input.startsAt,
      status: 'PUBLISHED',
      waitingRoomEnabled: input.waitingRoomEnabled ?? false,
      salePhases: { create: input.salePhases },
    },
  });
  const zones = [];
  for (const spec of input.zones) {
    const seated = spec.type === 'SEATED';
    const zone = await prisma.zone.create({
      data: {
        performanceId: performance.id,
        name: spec.name,
        type: spec.type,
        price: spec.price,
        capacity: seated
          ? (spec.rows ?? 0) * (spec.seatsPerRow ?? 0)
          : (spec.capacity ?? 0),
      },
    });
    zones.push({ id: zone.id, name: zone.name, type: zone.type });
    if (seated) {
      await prisma.seat.createMany({
        data: Array.from({ length: spec.rows ?? 0 }, (_, r) =>
          Array.from({ length: spec.seatsPerRow ?? 0 }, (_, s) => ({
            performanceId: performance.id,
            zoneId: zone.id,
            rowLabel: rowLabel(r),
            seatNumber: s + 1,
          })),
        ).flat(),
      });
    }
  }
  return { id: performance.id, zones };
}

interface SeededPerformance {
  id: string;
  zones: { id: string; name: string; type: ZoneType }[];
}

async function writeLoadTestData(
  prisma: PrismaClient,
  loadTest: SeededPerformance,
  onSale: SeededPerformance,
  presale: { performanceId: string; salePhaseId: string; codes: string[] },
): Promise<void> {
  const jwt = new JwtService({
    secret: required('JWT_ACCESS_SECRET'),
    signOptions: { algorithm: 'HS256' },
  });
  const ttl = Number(process.env.LOADTEST_TOKEN_TTL_SECONDS ?? 12 * 60 * 60);
  const customers = await prisma.user.findMany({
    where: { role: Role.CUSTOMER },
    select: { id: true, email: true },
    orderBy: { email: 'asc' },
  });
  const users = customers.map((u) => ({
    id: u.id,
    email: u.email,
    token: jwt.sign({ sub: u.id, role: Role.CUSTOMER }, { expiresIn: ttl }),
  }));

  // The gate staff account scans tickets in the check-in scenario.
  const staff = await prisma.user.findFirstOrThrow({
    where: { role: Role.STAFF },
    select: { id: true },
  });

  const seats = await prisma.seat.findMany({
    where: { performanceId: loadTest.id },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  // Insertion order (uuidv7): zone by zone, row by row, seat by seat, so
  // neighbouring ids are neighbouring seats (buyers pick blocks of them).
  const onSaleSeats = await prisma.seat.findMany({
    where: { performanceId: onSale.id },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(resolve(OUTPUT_DIR, 'users.json'), JSON.stringify(users));
  writeFileSync(
    resolve(OUTPUT_DIR, 'on-sale.json'),
    JSON.stringify({
      performanceId: onSale.id,
      zones: onSale.zones,
      seatIds: onSaleSeats.map((s) => s.id),
    }),
  );
  writeFileSync(
    resolve(OUTPUT_DIR, 'fixtures.json'),
    JSON.stringify(
      {
        loadTestPerformanceId: loadTest.id,
        zones: loadTest.zones,
        seatIds: seats.map((s) => s.id),
        onSalePerformanceId: onSale.id,
        presale,
        staffToken: jwt.sign(
          { sub: staff.id, role: Role.STAFF },
          { expiresIn: ttl },
        ),
        tokenExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
