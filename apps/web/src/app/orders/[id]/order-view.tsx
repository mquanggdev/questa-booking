'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api, call } from '@/lib/api/client';
import { ORDER_STATUS_LABEL, formatDateTime, formatVnd } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-require-auth';

/** Seconds left until `iso`, ticking every second. */
function useCountdown(iso: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return iso
    ? Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000))
    : null;
}

export function OrderView({ orderId }: { orderId: string }) {
  const { status } = useRequireAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orderKey = ['order', orderId];
  const { data: order, error: loadError } = useQuery({
    queryKey: orderKey,
    queryFn: () =>
      call(
        api.GET('/api/v1/orders/{id}', { params: { path: { id: orderId } } }),
      ),
    enabled: status === 'authenticated',
    // While unpaid, the state can change behind our back (payment IPN,
    // expiry job): keep it fresh.
    refetchInterval: (q) =>
      q.state.data?.status === 'PENDING' ? 3_000 : false,
  });
  const { data: seatMap } = useQuery({
    queryKey: ['seat-map', order?.performanceId],
    queryFn: () =>
      call(
        api.GET('/api/v1/performances/{id}/seats', {
          params: { path: { id: order!.performanceId } },
        }),
      ),
    enabled: !!order,
  });
  const secondsLeft = useCountdown(order?.expiresAt);

  if (loadError instanceof ApiError && loadError.status === 404) {
    return <p>Không tìm thấy đơn hàng.</p>;
  }
  if (!order) return <Skeleton className="h-64" />;

  const zones = new Map(seatMap?.zones.map((z) => [z.id, z]) ?? []);
  const seats = new Map(seatMap?.seats.map((s) => [s.id, s]) ?? []);
  const pending = order.status === 'PENDING';
  const expired = pending && secondsLeft === 0;

  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      const checkout = await call(
        api.POST('/api/v1/orders/{id}/pay', {
          params: { path: { id: orderId } },
          body: {},
        }),
      );
      // Full navigation: the gateway (fake page or VNPay) is another site.
      window.location.assign(checkout.checkoutUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tạo được thanh toán');
      setBusy(false);
    }
  };

  const cancel = async () => {
    setError(null);
    setBusy(true);
    try {
      await call(
        api.POST('/api/v1/orders/{id}/cancel', {
          params: { path: { id: orderId } },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không hủy được đơn');
    }
    await queryClient.invalidateQueries({ queryKey: orderKey });
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Đơn hàng</h1>
        <Badge
          data-testid="order-status"
          variant={order.status === 'PAID' ? 'default' : 'secondary'}
        >
          {ORDER_STATUS_LABEL[order.status]}
        </Badge>
      </div>

      <ul className="divide-y rounded-lg border">
        {order.items.map((item) => {
          const seat = item.seatId ? seats.get(item.seatId) : undefined;
          return (
            <li key={item.id} className="flex justify-between p-3 text-sm">
              <span>
                {zones.get(item.zoneId)?.name ?? 'Khu'}
                {seat ? ` · hàng ${seat.row} ghế ${seat.number}` : ' · vé đứng'}
              </span>
              <span>{formatVnd(item.price)}</span>
            </li>
          );
        })}
        <li className="flex justify-between p-3 font-medium">
          <span>Tổng</span>
          <span>{formatVnd(order.totalAmount)}</span>
        </li>
      </ul>

      {pending && !expired && secondsLeft !== null && (
        <p className="text-sm">
          Vé được giữ cho bạn thêm{' '}
          <span className="font-mono font-semibold" data-testid="countdown">
            {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, '0')}
          </span>{' '}
          (đến {formatDateTime(order.expiresAt)}).
        </p>
      )}
      {expired && (
        <Alert>
          <AlertDescription>
            Hết thời gian giữ vé. Nếu bạn vừa thanh toán, hệ thống vẫn chờ kết
            quả thêm 2 phút; tiền về muộn hơn sẽ được hoàn tự động.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {pending && !expired && (
        <div className="flex gap-3">
          <Button className="flex-1" onClick={pay} disabled={busy}>
            Thanh toán {formatVnd(order.totalAmount)}
          </Button>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            Hủy đơn
          </Button>
        </div>
      )}
      {order.status === 'PAID' && (
        <Link
          href="/tickets"
          className={buttonVariants({ className: 'w-full' })}
        >
          Xem vé QR
        </Link>
      )}
      {(order.status === 'REFUND_PENDING' || order.status === 'REFUNDED') && (
        <p className="text-sm text-muted-foreground">
          Khoản thanh toán của đơn này{' '}
          {order.status === 'REFUNDED' ? 'đã được' : 'đang được'} hoàn lại.
        </p>
      )}
    </div>
  );
}
