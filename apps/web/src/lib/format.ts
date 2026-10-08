const vnd = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

const date = new Intl.DateTimeFormat('vi-VN', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Ho_Chi_Minh',
});

const time = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Ho_Chi_Minh',
});

export const formatVnd = (amount: number) => vnd.format(amount);
export const formatTime = (iso: string) => time.format(new Date(iso));
/** "Thứ Tư, 21/10/2026 · 21:48" (Vietnam time). */
export const formatDateTime = (iso: string) =>
  `${date.format(new Date(iso))} · ${formatTime(iso).slice(0, 5)}`;

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ thanh toán',
  PAID: 'Đã thanh toán',
  EXPIRED: 'Hết hạn',
  CANCELLED: 'Đã hủy',
  REFUND_PENDING: 'Đang hoàn tiền',
  REFUNDED: 'Đã hoàn tiền',
};
