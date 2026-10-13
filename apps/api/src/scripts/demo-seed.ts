/**
 * Data of the online demo (phase 9). Safe on a production database:
 *
 * - it never deletes anything, and does nothing if a concert already exists;
 * - it creates through the same services as the API (validation, seat
 *   layout, presale codes), not with raw inserts.
 *
 *   docker compose -p questa-booking -f docker-compose.prod.yml \
 *     run --rm api node dist/scripts/demo-seed.js
 *
 * Creates the public read-only organizer (DEMO_ORGANIZER_EMAIL and
 * _PASSWORD), and three concerts: a stadium night on general sale, a night
 * behind the virtual waiting room, and a night in its presale (the presale
 * codes are printed once, for the demo page).
 */
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { AppModule } from '../app.module.js';
import type { AuthUser } from '../common/auth/auth.decorators.js';
import { AppConfigService } from '../config/app-config.service.js';
import { Role, type SalePhaseType } from '../generated/prisma/client.js';
import { ConcertsService } from '../modules/concerts/concerts.service.js';
import type { CreateZoneDto } from '../modules/concerts/dto/performance.dto.js';
import { PerformancesService } from '../modules/concerts/performances.service.js';
import { PresaleService } from '../modules/concerts/presale.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY = 24 * 60 * 60 * 1000;

const STADIUM: CreateZoneDto[] = [
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
const THEATER: CreateZoneDto[] = [
  {
    name: 'FAN ZONE',
    type: 'SEATED',
    price: 1_500_000,
    rows: 10,
    seatsPerRow: 20,
  },
  { name: 'GA', type: 'STANDING', price: 700_000, capacity: 300 },
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    if ((await prisma.concert.count()) > 0) {
      console.log('The database already has concerts: nothing to do.');
      return;
    }
    const config = app.get(AppConfigService);
    const password = config.get('DEMO_ORGANIZER_PASSWORD');
    if (!password) throw new Error('Set DEMO_ORGANIZER_PASSWORD');

    const user = await prisma.user.create({
      data: {
        email: config.get('DEMO_ORGANIZER_EMAIL'),
        passwordHash: await argon2.hash(password),
        fullName: 'Ban tổ chức demo',
        role: Role.ORGANIZER,
        isDemo: true,
      },
    });
    const organizer: AuthUser = { id: user.id, role: Role.ORGANIZER };
    const concerts = app.get(ConcertsService, { strict: false });
    const performances = app.get(PerformancesService, { strict: false });
    const presale = app.get(PresaleService, { strict: false });

    const now = Date.now();
    const night = async (
      concertId: string,
      days: number,
      venue: string,
      zones: CreateZoneDto[],
      phases: (
        startsAt: Date,
      ) => { type: SalePhaseType; startsAt: Date; endsAt: Date }[],
      waitingRoomEnabled = false,
    ) => {
      const startsAt = new Date(now + days * DAY);
      const created = await performances.create(concertId, organizer, {
        venue,
        startsAt,
        zones,
        salePhases: phases(startsAt),
        waitingRoomEnabled,
      });
      await performances.publish(created.id, organizer);
      return created;
    };
    const generalNow = (startsAt: Date) => [
      {
        type: 'GENERAL' as const,
        startsAt: new Date(now - DAY),
        endsAt: new Date(startsAt.getTime() - DAY),
      },
    ];

    const fest = await concerts.create(organizer, {
      name: 'Questa Fest 2026',
      artist: 'The Questa Collective',
      description: 'Hai đêm, 20.000 khán giả. Sơ đồ ghế cập nhật trực tiếp.',
    });
    for (const days of [60, 61]) {
      await night(fest.id, days, 'Sân vận động Mỹ Đình', STADIUM, generalNow);
    }

    const arena = await concerts.create(organizer, {
      name: 'Questa Arena Live',
      artist: 'Neon Harbor',
      description: 'Một đêm, 10.000 vé, có hàng chờ ảo trước khi chọn vé.',
    });
    await night(arena.id, 75, 'Nhà thi đấu Phú Thọ', STADIUM, generalNow, true);

    const fans = await concerts.create(organizer, {
      name: 'Questa Fan Club Night',
      artist: 'The Questa Collective',
      description: 'Đợt bán trước chỉ dành cho người có mã ưu tiên.',
    });
    const fanNight = await night(
      fans.id,
      90,
      'Nhà hát Hòa Bình',
      THEATER,
      (startsAt) => [
        {
          type: 'PRESALE',
          startsAt: new Date(now - DAY),
          endsAt: new Date(now + 45 * DAY),
        },
        {
          type: 'GENERAL',
          startsAt: new Date(now + 45 * DAY),
          endsAt: new Date(startsAt.getTime() - DAY),
        },
      ],
    );
    const presalePhase = fanNight.salePhases.find((p) => p.type === 'PRESALE')!;
    // Generated through the service while the account is still writable:
    // the read-only rule applies to HTTP requests, not to this script.
    const { codes } = await presale.generate(fanNight.id, organizer, {
      salePhaseId: presalePhase.id,
      count: 100,
    });

    console.log(`Demo organizer: ${user.email} (read-only)`);
    console.log(`Presale codes of "${fans.name}" (single use):`);
    console.log(codes.join('\n'));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
