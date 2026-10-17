import { expect, test } from '@playwright/test';
import { clickSeat, createPerformance, signUp } from './support/fixtures';

// Phase 8: a sale travels outbox -> relay -> Kafka -> analytics consumer ->
// Redis -> /sales WebSocket, and the organizer's dashboard shows it without
// a reload. Runs against the Docker stack (worker with Kafka).

test('the organizer sees a sale appear live on the sales dashboard', async ({
  browser,
  request,
}) => {
  const performance = await createPerformance(request);

  const organizer = await browser.newPage();
  await organizer.goto('/login');
  await organizer.getByLabel('Email').fill('organizer@questa.test');
  await organizer
    .getByLabel('Mật khẩu')
    .fill(process.env.SEED_PASSWORD ?? 'Questa@2026');
  await organizer
    .getByRole('main')
    .getByRole('button', { name: 'Đăng nhập' })
    .click();
  await expect(
    organizer.getByRole('button', { name: 'Đăng xuất' }),
  ).toBeVisible();
  await organizer.goto(`/performances/${performance.id}`);
  await organizer.getByRole('link', { name: 'Theo dõi mở bán' }).click();
  await expect(organizer.getByText('● Cập nhật trực tiếp')).toBeVisible();
  await expect(organizer.getByTestId('sold')).toHaveText('0 vé');

  // A customer buys one seat and one standing ticket.
  const buyer = await browser.newPage();
  await signUp(buyer);
  await buyer.goto(`/performances/${performance.id}`);
  await clickSeat(buyer, 'A3');
  await buyer.getByRole('button', { name: 'Thêm vé Đứng' }).click();
  await buyer.getByRole('button', { name: 'Giữ 2 vé' }).click();
  await expect(buyer).toHaveURL(/\/orders\//);
  await buyer.getByRole('button', { name: 'Cổng thanh toán giả lập' }).click();
  await buyer.getByRole('button', { name: 'Thanh toán thành công' }).click();
  await expect(buyer.getByTestId('payment-result')).toHaveText(
    'Thanh toán thành công',
  );

  // Pushed over the WebSocket (the poll runs only every 10 s).
  await expect(organizer.getByTestId('sold')).toHaveText('2 vé', {
    timeout: 8000,
  });
  await expect(organizer.getByTestId('revenue')).toHaveText(/1\.500\.000/);
});
