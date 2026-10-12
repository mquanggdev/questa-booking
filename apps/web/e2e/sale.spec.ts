import { expect, test } from '@playwright/test';
import { clickSeat, createPerformance, signUp } from './support/fixtures';

// Phase 7b: presale codes and the virtual waiting room, end to end on the
// production build (the stack's worker admits the line every second).

test('presale: holding needs a redeemed code; a wrong code is refused, the right one unlocks the sale', async ({
  page,
  request,
}) => {
  const performance = await createPerformance(request, { presale: true });
  await signUp(page);
  await page.goto(`/performances/${performance.id}`);
  const panel = page.getByTestId('presale-panel');
  await expect(
    panel.getByRole('heading', { name: 'Đợt bán trước' }),
  ).toBeVisible();

  // Without a code the API refuses the hold.
  await clickSeat(page, 'A1');
  await page.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(
    page.getByText(
      'Đợt bán trước chỉ dành cho tài khoản đã kích hoạt mã ưu tiên.',
    ),
  ).toBeVisible();

  await panel.getByLabel('Mã ưu tiên').fill('ABCD-EFGH-JK');
  await panel.getByRole('button', { name: 'Kích hoạt' }).click();
  await expect(
    panel.getByText('Mã không đúng hoặc không dành cho đêm diễn này.'),
  ).toBeVisible();

  // Typed in lower case with spaces: still the same code.
  const typed = performance.presaleCodes[0]!.toLowerCase().replace(/-/g, ' ');
  await panel.getByLabel('Mã ưu tiên').fill(typed);
  await panel.getByRole('button', { name: 'Kích hoạt' }).click();
  await expect(panel.getByText('Đã kích hoạt mã')).toBeVisible();

  await page.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(page).toHaveURL(/\/orders\//);
  await expect(page.getByTestId('order-status')).toHaveText('Chờ thanh toán');
});

test('waiting room: the buyer queues, is admitted live, then holds a seat', async ({
  page,
  request,
}) => {
  const performance = await createPerformance(request, { waitingRoom: true });
  await signUp(page);
  await page.goto(`/performances/${performance.id}`);

  // No seat map before admission.
  const room = page.getByTestId('waiting-room');
  await expect(room).toHaveAttribute('data-status', 'NONE');
  await expect(page.getByTestId('seat-picker')).toHaveCount(0);

  await room.getByRole('button', { name: 'Vào hàng chờ' }).click();
  // The worker admits every second; the page switches without a reload.
  await expect(page.getByTestId('queue-pass')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('queue-pass')).toContainText('Đến lượt bạn!');

  await clickSeat(page, 'B2');
  await page.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(page).toHaveURL(/\/orders\//);
});
