'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api, call } from '@/lib/api/client';
import { ORDER_STATUS_LABEL, formatDateTime, formatVnd } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-require-auth';

export default function OrdersPage() {
  const { status } = useRequireAuth();
  const { data: orders } = useQuery({
    queryKey: ['orders'],
    queryFn: () => call(api.GET('/api/v1/orders')),
    enabled: status === 'authenticated',
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Đơn hàng của tôi</h1>
      {!orders ? (
        <Skeleton className="h-40" />
      ) : orders.length === 0 ? (
        <p className="text-muted-foreground">
          Bạn chưa có đơn nào.{' '}
          <Link href="/" className="underline">
            Xem concert
          </Link>
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                href={`/orders/${o.id}`}
                className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50"
              >
                <div>
                  <div className="font-medium">
                    {o.items.length} vé · {formatVnd(o.totalAmount)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Đặt lúc {formatDateTime(o.createdAt)}
                  </div>
                </div>
                <Badge variant={o.status === 'PAID' ? 'default' : 'secondary'}>
                  {ORDER_STATUS_LABEL[o.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
