import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;

export interface TestPerformance {
  id: string;
  name: string;
}

/**
 * A fresh, published performance on sale right now: 2 rows of 5 seats and
 * 20 standing tickets. Created through the API as the seeded organizer, so
 * tests never depend on (or disturb) each other's inventory.
 */
export async function createPerformance(
  request: APIRequestContext,
): Promise<TestPerformance> {
  const login = await request.post('/api/v1/auth/login', {
    data: {
      email: 'organizer@questa.test',
      password: process.env.SEED_PASSWORD ?? 'Questa@2026',
    },
  });
  expect(login.ok(), 'seeded organizer can log in (run db:seed)').toBeTruthy();
  const headers = {
    Authorization: `Bearer ${(await login.json()).accessToken as string}`,
  };

  const name = `E2E ${randomUUID().slice(0, 8)}`;
  const concert = await request.post('/api/v1/concerts', {
    headers,
    data: { name, artist: 'Playwright Band' },
  });
  expect(concert.ok()).toBeTruthy();
  const startsAt = new Date(Date.now() + 30 * DAY);
  const performance = await request.post(
    `/api/v1/concerts/${(await concert.json()).id as string}/performances`,
    {
      headers,
      data: {
        venue: 'Test Hall',
        startsAt,
        maxTicketsPerUser: 6,
        zones: [
          {
            name: 'Ghế',
            type: 'SEATED',
            price: 1_000_000,
            rows: 2,
            seatsPerRow: 5,
          },
          { name: 'Đứng', type: 'STANDING', price: 500_000, capacity: 20 },
        ],
        salePhases: [
          {
            type: 'GENERAL',
            startsAt: new Date(Date.now() - DAY),
            endsAt: new Date(startsAt.getTime() - DAY),
          },
        ],
      },
    },
  );
  expect(performance.ok()).toBeTruthy();
  const id = (await performance.json()).id as string;
  const publish = await request.post(`/api/v1/performances/${id}/publish`, {
    headers,
  });
  expect(publish.ok()).toBeTruthy();
  return { id, name };
}

/** Registers a brand-new customer through the UI; ends signed in. */
export async function signUp(page: Page): Promise<string> {
  const email = `e2e-${randomUUID()}@test.local`;
  await page.goto('/register');
  await page.getByLabel('Họ tên').fill('Khách Playwright');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  return email;
}

/**
 * Clicks a seat on the Konva canvas. Seats are not DOM elements, so the test
 * asks Konva where the shape named `seat-<label>` is drawn, then clicks there
 * like a user would.
 */
export async function clickSeat(page: Page, label: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      !!(
        window as unknown as { Konva?: KonvaGlobal }
      ).Konva?.stages?.[0]?.findOne(`.seat-${name}`),
    label,
  );
  const point = await page.evaluate((name) => {
    const stage = (window as unknown as { Konva: KonvaGlobal }).Konva.stages[0];
    const box = stage.container().getBoundingClientRect();
    const rect = stage.findOne(`.seat-${name}`)!.getClientRect();
    return {
      x: box.left + rect.x + rect.width / 2,
      y: box.top + rect.y + rect.height / 2,
    };
  }, label);
  await page.mouse.click(point.x, point.y);
}

interface KonvaGlobal {
  stages: {
    container(): HTMLElement;
    findOne(selector: string):
      | {
          getClientRect(): {
            x: number;
            y: number;
            width: number;
            height: number;
          };
        }
      | undefined;
  }[];
}
