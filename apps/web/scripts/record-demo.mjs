// Records the buying flow in a real browser and turns it into the GIF shown
// in the README (docs/assets/buying-flow.gif). Same steps as the Playwright
// test, slowed down so a human can follow.
//
//   docker compose up -d --build && pnpm --filter @questa/api db:seed
//   pnpm --filter @questa/web record:demo
//
// ffmpeg comes from the imageio-ffmpeg wheel through `uv`, so nothing is
// installed on the machine.
import { chromium, request } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3200';
const repo = resolve(import.meta.dirname, '../../..');
const output = resolve(repo, 'docs/assets/buying-flow.gif');
const seedPassword =
  process.env.SEED_PASSWORD ??
  parseEnv(readFileSync(resolve(repo, '.env'), 'utf8')).SEED_PASSWORD;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

/** A small performance on sale now, created as the seeded organizer. */
async function createPerformance() {
  const api = await request.newContext({ baseURL: BASE });
  const login = await api.post('/api/v1/auth/login', {
    data: { email: 'organizer@questa.test', password: seedPassword },
  });
  const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const concert = await api.post('/api/v1/concerts', {
    headers,
    data: { name: 'Đêm nhạc Questa', artist: 'The Questa Collective' },
  });
  const startsAt = new Date(Date.now() + 30 * DAY);
  const perf = await api.post(`/api/v1/concerts/${(await concert.json()).id}/performances`, {
    headers,
    data: {
      venue: 'Nhà hát Hòa Bình',
      startsAt,
      maxTicketsPerUser: 6,
      zones: [
        { name: 'VIP', type: 'SEATED', price: 2_000_000, rows: 4, seatsPerRow: 12 },
        { name: 'Khu đứng', type: 'STANDING', price: 600_000, capacity: 200 },
      ],
      salePhases: [
        { type: 'GENERAL', startsAt: new Date(Date.now() - DAY), endsAt: new Date(startsAt - DAY) },
      ],
    },
  });
  const id = (await perf.json()).id;
  await api.post(`/api/v1/performances/${id}/publish`, { headers });
  await api.dispose();
  return id;
}

async function clickSeat(page, label) {
  await page.waitForFunction((n) => !!window.Konva?.stages?.[0]?.findOne(`.seat-${n}`), label);
  const p = await page.evaluate((n) => {
    const stage = window.Konva.stages[0];
    const box = stage.container().getBoundingClientRect();
    const r = stage.findOne(`.seat-${n}`).getClientRect();
    return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
  }, label);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await pause(250);
  await page.mouse.click(p.x, p.y);
  await pause(500);
}

const performanceId = await createPerformance();
const videoDir = join(tmpdir(), `questa-demo-${randomUUID()}`);
const size = { width: 1180, height: 720 };
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: videoDir, size },
  locale: 'vi-VN',
});
const page = await context.newPage();

// 1. Sign up.
await page.goto(`${BASE}/register?next=/performances/${performanceId}`);
await page.getByLabel('Họ tên').pressSequentially('Nguyễn Văn A', { delay: 40 });
await page.getByLabel('Email').pressSequentially(`khach-${Date.now()}@questa.test`, { delay: 20 });
await page.getByLabel('Mật khẩu').pressSequentially('correct-horse-battery', { delay: 20 });
await page.getByRole('button', { name: 'Đăng ký' }).click();

// 2. Pick two seats and two standing tickets, hold them.
await page.waitForURL(`**/performances/${performanceId}`);
await pause(1500);
await clickSeat(page, 'B5');
await clickSeat(page, 'B6');
for (let i = 0; i < 2; i += 1) {
  await page.getByRole('button', { name: 'Thêm vé Khu đứng' }).click();
  await pause(400);
}
await pause(1000);
await page.getByRole('button', { name: /Giữ 4 vé/ }).click();

// 3. The order, with its countdown; pay at the gateway.
await page.waitForURL('**/orders/**');
await pause(2500);
await page.getByRole('button', { name: /Thanh toán/ }).click();
await page.waitForURL('**/checkout/fake-gateway**');
await pause(2000);
await page.getByRole('button', { name: 'Thanh toán thành công' }).click();

// 4. Confirmed through the IPN, then the QR tickets.
await page.getByText('Thanh toán thành công', { exact: true }).waitFor();
await pause(2000);
await page.getByRole('link', { name: 'Xem vé QR' }).click();
await page.getByTestId('ticket').first().waitFor();
await pause(3500);

const video = await page.video().path();
await context.close();
await browser.close();

// webm -> GIF: two-pass palette for clean colours, 10 fps, 900 px wide.
const ffmpeg = spawnSync(
  'uv',
  ['run', '--with', 'imageio-ffmpeg', 'python', '-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
  { encoding: 'utf8' },
).stdout.trim();
mkdirSync(resolve(repo, 'docs/assets'), { recursive: true });
const filters = 'fps=10,scale=900:-1:flags=lanczos';
const run = (args) => {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
};
const palette = join(videoDir, 'palette.png');
run(['-i', video, '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
run(['-i', video, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`, output]);
rmSync(videoDir, { recursive: true, force: true });
console.log(`Wrote ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
