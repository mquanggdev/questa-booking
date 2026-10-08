'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, call } from '@/lib/api/client';
import { ORDER_STATUS_LABEL } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-require-auth';

/**
 * Where the gateway sends the browser back. The redirect itself proves
 * nothing (it can be replayed or faked), so this page only asks the API what
 * it means, then waits for the order to change: that happens through the
 * IPN, server to server.
 */
export function PaymentResult({ provider }: { provider: string }) {
  const { status } = useRequireAuth();
  const query = useSearchParams().toString();

  const { data: back } = useQuery({
    queryKey: ['payment-return', provider, query],
    queryFn: async () => {
      // The signed parameters are forwarded untouched.
      const res = await fetch(
        `/api/v1/payments/return/${encodeURIComponent(provider)}?${query}`,
      );
      return (await res.json()) as {
        verified: boolean;
        gatewaySaysSuccess: boolean;
        orderId: string | null;
      };
    },
  });
  const orderId = back?.orderId ?? null;
  const { data: order } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () =>
      call(
        api.GET('/api/v1/orders/{id}', { params: { path: { id: orderId! } } }),
      ),
    enabled: status === 'authenticated' && orderId !== null,
    refetchInterval: (q) =>
      q.state.data?.status === 'PENDING' ? 2_000 : false,
  });

  if (!back) return <Skeleton className="h-40" />;
  if (!back.verified) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Không xác minh được kết quả từ cổng thanh toán.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6 text-center">
      <h1 className="text-2xl font-semibold" data-testid="payment-result">
        {!back.gatewaySaysSuccess
          ? 'Thanh toán chưa thành công'
          : order?.status === 'PAID'
            ? 'Thanh toán thành công'
            : order && order.status !== 'PENDING'
              ? ORDER_STATUS_LABEL[order.status]
              : 'Đang chờ xác nhận từ cổng thanh toán…'}
      </h1>
      {back.gatewaySaysSuccess && order?.status === 'PENDING' && (
        <p className="text-sm text-muted-foreground">
          Đơn được xác nhận khi cổng thanh toán báo kết quả trực tiếp cho hệ
          thống (IPN), thường chỉ vài giây.
        </p>
      )}
      {(order?.status === 'REFUND_PENDING' || order?.status === 'REFUNDED') && (
        <p className="text-sm text-muted-foreground">
          Tiền về sau khi đơn đã đóng, nên hệ thống tự hoàn lại khoản thanh toán
          này.
        </p>
      )}
      <div className="flex justify-center gap-3">
        {order?.status === 'PAID' && (
          <Link href="/tickets" className={buttonVariants()}>
            Xem vé QR
          </Link>
        )}
        {orderId && (
          <Link
            href={`/orders/${orderId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            Xem đơn hàng
          </Link>
        )}
      </div>
    </div>
  );
}
