import { expect, test } from '@playwright/test';
import {
  clickSeat,
  createPerformance,
  signUp,
  type TestPerformance,
} from './support/fixtures';

let performance: TestPerformance;

test.beforeAll(async ({ request }) => {
  performance = await createPerformance(request);
});

test('a new customer buys two seats and a standing ticket and gets QR tickets', async ({
  page,
}) => {
  await signUp(page);
  await page.goto(`/performances/${performance.id}`);

  await clickSeat(page, 'A1');
  await clickSeat(page, 'A2');
  await page.getByRole('button', { name: 'Thêm vé Đứng' }).click();
  await expect(page.getByTestId('selection-total')).toHaveText(/2\.500\.000/);
  await page.getByRole('button', { name: 'Giữ 3 vé' }).click();

  // The hold succeeded: an unpaid order with a countdown.
  await expect(page).toHaveURL(/\/orders\//);
  await expect(page.getByTestId('order-status')).toHaveText('Chờ thanh toán');
  await expect(page.getByTestId('countdown')).toBeVisible();

  await page.getByRole('button', { name: /Thanh toán/ }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway/);
  await page.getByRole('button', { name: 'Thanh toán thành công' }).click();

  // Back from the gateway: the order is confirmed through the IPN.
  await expect(page).toHaveURL(/\/checkout\/result\/fake/);
  await expect(page.getByTestId('payment-result')).toHaveText(
    'Thanh toán thành công',
  );
  await page.getByRole('link', { name: 'Xem vé QR' }).click();

  const tickets = page.getByTestId('ticket');
  await expect(tickets).toHaveCount(3);
  await expect(tickets.locator('svg')).toHaveCount(3);
  await expect(page.getByText('Ghế · ghế A1')).toBeVisible();
  await expect(page.getByText('Ghế · ghế A2')).toBeVisible();
  await expect(page.getByText('Đứng · vé đứng')).toBeVisible();
});

test('two customers pick the same seat: only one can hold it', async ({
  browser,
}) => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await signUp(first);
  await signUp(second);
  for (const page of [first, second]) {
    await page.goto(`/performances/${performance.id}`);
    await clickSeat(page, 'B1');
    await expect(page.getByRole('button', { name: 'Giữ 1 vé' })).toBeEnabled();
  }

  await first.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(first).toHaveURL(/\/orders\//);

  // The second customer still sees B1 selected (the map refreshes every few
  // seconds) and tries anyway: the server refuses, the page explains.
  await second.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(second.getByText(/vừa có người khác giữ/)).toBeVisible();
  await expect(second.getByRole('button', { name: 'Giữ 0 vé' })).toBeDisabled();
  await expect(second).toHaveURL(new RegExp(`/performances/${performance.id}`));
});

test('cancelled at the gateway: the order stays payable, then the customer cancels it', async ({
  page,
}) => {
  await signUp(page);
  await page.goto(`/performances/${performance.id}`);
  await clickSeat(page, 'A5');
  await page.getByRole('button', { name: 'Giữ 1 vé' }).click();
  await expect(page).toHaveURL(/\/orders\//);
  const orderUrl = page.url();

  await page.getByRole('button', { name: /Thanh toán/ }).click();
  await page.getByRole('button', { name: 'Hủy giao dịch' }).click();
  await expect(page.getByTestId('payment-result')).toHaveText(
    'Thanh toán chưa thành công',
  );

  await page.goto(orderUrl);
  await expect(page.getByTestId('order-status')).toHaveText('Chờ thanh toán');
  await page.getByRole('button', { name: 'Hủy đơn' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Đã hủy');
});

test('pages that need an account send visitors to the login page and back', async ({
  page,
}) => {
  await page.goto('/tickets');
  await expect(page).toHaveURL(/\/login\?next=%2Ftickets/);
  // The form's link (not the header's) carries ?next= along.
  await page.getByRole('main').getByRole('link', { name: 'Đăng ký' }).click();
  await expect(page).toHaveURL(/\/register\?next=%2Ftickets/);
  await page.getByLabel('Họ tên').fill('Khách quay lại');
  await page.getByLabel('Email').fill(`e2e-back-${Date.now()}@test.local`);
  await page.getByLabel('Mật khẩu').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByText('Bạn chưa có vé nào.')).toBeVisible();
});
