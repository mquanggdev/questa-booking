// Screenshots the Grafana dashboard for the README
// (docs/assets/grafana-dashboard.png). Run it right after a load test, so
// the last 15 minutes have something to show:
//
//   docker compose --profile monitoring up -d
//   pnpm loadtest on-sale && pnpm loadtest full-flow
//   pnpm --filter @questa/web screenshot:dashboard
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3300';
const output = resolve(import.meta.dirname, '../../../docs/assets/grafana-dashboard.png');

const browser = await chromium.launch();
// Tall enough for every panel: Grafana only draws panels inside the viewport.
const page = await browser.newPage({ viewport: { width: 1600, height: 1760 }, deviceScaleFactor: 1 });
// Anonymous viewer (read-only), kiosk mode: no Grafana chrome around it.
await page.goto(`${GRAFANA}/d/questa-overview/questa-booking?orgId=1&from=now-12m&to=now&kiosk`, {
  waitUntil: 'networkidle',
});
// Every panel has drawn its canvas (time series) before the shot.
await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 12, null, { timeout: 60_000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: output });
await browser.close();
console.log(`Wrote ${output}`);
