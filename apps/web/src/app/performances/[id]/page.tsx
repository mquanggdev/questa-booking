import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { SeatPicker } from '@/components/seat-map/seat-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { serverApi } from '@/lib/api/server';
import { formatDateTime } from '@/lib/format';

export default function PerformancePage({
  params,
}: PageProps<'/performances/[id]'>) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Performance params={params} />
    </Suspense>
  );
}

async function Performance({
  params,
}: {
  params: PageProps<'/performances/[id]'>['params'];
}) {
  const { id } = await params;
  const { data: p } = await serverApi.GET('/api/v1/performances/{id}', {
    params: { path: { id } },
  });
  if (!p) notFound();

  // Rendered per request, so "now" is the request time.
  const now = new Date();
  const general = p.salePhases.find((s) => s.type === 'GENERAL');
  const onSale =
    p.status === 'PUBLISHED' &&
    general !== undefined &&
    new Date(general.startsAt) <= now &&
    now < new Date(general.endsAt);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/concerts/${p.concert.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {p.concert.name}
        </Link>
        <h1 className="text-2xl font-semibold">
          {p.concert.name} — {p.concert.artist}
        </h1>
        <p className="text-muted-foreground">
          {formatDateTime(p.startsAt)} · {p.venue}
        </p>
      </div>
      {p.status === 'CANCELLED' ? (
        <Alert variant="destructive">
          <AlertDescription>
            Đêm diễn đã bị hủy. Vé đã mua được hoàn tiền tự động.
          </AlertDescription>
        </Alert>
      ) : !onSale ? (
        <Alert>
          <AlertDescription>
            Đêm diễn chưa mở bán hoặc đã kết thúc bán vé
            {general
              ? ` (mở bán ${formatDateTime(general.startsAt)} – ${formatDateTime(general.endsAt)})`
              : ''}
            .
          </AlertDescription>
        </Alert>
      ) : (
        <SeatPicker performanceId={p.id} maxTickets={p.maxTicketsPerUser} />
      )}
    </div>
  );
}
