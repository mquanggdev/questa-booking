'use client';

import Link from 'next/link';
import { useSalesStats } from '@/components/sales/use-sales-stats';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { formatDateTime, formatVnd } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-require-auth';

/** The organizer's live sales dashboard (spec: "Trang theo dõi mở bán"). */
export function SalesView({ performanceId: id }: { performanceId: string }) {
  const { status, user } = useRequireAuth();
  const isOrganizer = user?.role === 'ORGANIZER';
  const { stats, error, connected, lastPush } = useSalesStats(
    id,
    status === 'authenticated' && isOrganizer,
  );

  if (status === 'authenticated' && !isOrganizer) {
    return <Denied text="Trang này chỉ dành cho ban tổ chức." />;
  }
  if (error) {
    return (
      <Denied
        text={
          error instanceof ApiError && error.status === 403
            ? 'Bạn không phải ban tổ chức của đêm diễn này.'
            : 'Không tải được số liệu.'
        }
      />
    );
  }
  if (!stats) return <Skeleton className="h-96" />;

  const pct = (n: number) =>
    stats.capacity === 0 ? '0%' : `${Math.round((n / stats.capacity) * 100)}%`;

  return (
    <div className="space-y-6" data-testid="sales-dashboard">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link
            href={`/performances/${id}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Trang mua vé
          </Link>
          <h1 className="text-2xl font-semibold">Theo dõi mở bán</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          {connected ? '● Cập nhật trực tiếp' : '○ Đang kết nối lại…'}
          {lastPush
            ? ` · cập nhật lúc ${formatDateTime(lastPush.toISOString())}`
            : ''}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Đã bán"
          value={`${stats.ticketsSold} vé`}
          sub={pct(stats.ticketsSold)}
          testId="sold"
        />
        <Stat
          label="Doanh thu"
          value={formatVnd(stats.revenue)}
          testId="revenue"
        />
        <Stat
          label="Đang giữ"
          value={`${stats.ticketsHeld} vé`}
          sub="chưa thanh toán"
        />
        <Stat
          label="Hàng chờ"
          value={`${stats.queueLength} người`}
          sub="đang chờ vào"
        />
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Khu</th>
            <th>Sức chứa</th>
            <th>Đã bán</th>
            <th>Đang giữ</th>
            <th className="text-right">Doanh thu</th>
          </tr>
        </thead>
        <tbody>
          {stats.zones.map((z) => (
            <tr key={z.zoneId} className="border-t">
              <td className="py-2 font-medium">
                {z.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {z.type === 'STANDING' ? 'vé đứng' : 'ghế ngồi'}
                </span>
              </td>
              <td className="tabular-nums">{z.capacity}</td>
              <td className="tabular-nums">{z.ticketsSold}</td>
              <td className="tabular-nums">{z.ticketsHeld}</td>
              <td className="text-right tabular-nums">
                {formatVnd(z.revenue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Số vé đã bán và doanh thu đến từ sự kiện thanh toán (qua outbox và
        Kafka), nên có thể trễ vài trăm mili giây so với lúc thanh toán. Vé đang
        giữ và hàng chờ được đọc trực tiếp.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Denied({ text }: { text: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
