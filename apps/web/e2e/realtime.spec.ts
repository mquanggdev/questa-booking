import { expect, test, type Page } from '@playwright/test';
import { clickSeat, createPerformance, signUp } from './support/fixtures';

// Phase 7a's definition of done: two browsers connected to two different
// API replicas both see a seat change. Run against the Docker stack (Nginx
// in front of 2 replicas); with a single API it cannot pass.

const HELD = '#f59e0b';

const picker = (page: Page) => page.getByTestId('seat-picker');

async function connectedInstance(page: Page): Promise<string> {
  await expect(picker(page)).toHaveAttribute('data-ws-connected', 'true');
  return (await picker(page).getAttribute('data-ws-instance')) ?? '';
}

// Konva is loaded after the page (dynamic import): wait for the shape.
const seatColor = async (page: Page, label: string) => {
  await page.waitForFunction(
    (name) =>
      !!(
        window as unknown as {
          Konva?: { stages?: { findOne(s: string): unknown }[] };
        }
      ).Konva?.stages?.[0]?.findOne(`.seat-${name}`),
    label,
  );
  return page.evaluate(
    (name) =>
      (
        window as unknown as {
          Konva: { stages: { findOne(s: string): { fill(): string } }[] };
        }
      ).Konva.stages[0]
        .findOne(`.seat-${name}`)
        .fill(),
    label,
  );
};

test('two browsers on two different API replicas both see a seat change live', async ({
  browser,
  request,
}) => {
  const performance = await createPerformance(request);
  const url = `/performances/${performance.id}`;

  const buyer = await browser.newPage();
  await signUp(buyer);
  await buyer.goto(url);
  const buyerInstance = await connectedInstance(buyer);

  // Nginx balances connections round robin: reconnect the watcher until it
  // lands on the other replica.
  const watcher = await browser.newPage();
  await watcher.goto(url);
  let watcherInstance = await connectedInstance(watcher);
  for (let i = 0; i < 10 && watcherInstance === buyerInstance; i += 1) {
    await watcher.reload();
    watcherInstance = await connectedInstance(watcher);
  }
  expect(watcherInstance).not.toBe('');
  expect(watcherInstance).not.toBe(buyerInstance);

  const seqBefore = await picker(watcher).getAttribute('data-seq');
  await clickSeat(buyer, 'A3');
  await buyer.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(buyer).toHaveURL(/\/orders\//);

  // Polling runs every 30 s while the socket is connected, so a change
  // within 3 s came over the WebSocket, relayed by Redis across replicas.
  await expect
    .poll(() => seatColor(watcher, 'A3'), { timeout: 3_000 })
    .toBe(HELD);
  await expect(picker(watcher)).not.toHaveAttribute(
    'data-seq',
    seqBefore ?? '',
  );
  // The holder's own replica pushes the same change to its other sockets.
  const third = await browser.newPage();
  await third.goto(url);
  await connectedInstance(third);
  expect(await seatColor(third, 'A3')).toBe(HELD);
});
