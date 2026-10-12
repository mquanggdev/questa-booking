import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { PresalePanel } from '@/components/sale/presale-panel';
import { WaitingRoom } from '@/components/sale/waiting-room';
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
  const open = p.salePhases.find(
    (s) => new Date(s.startsAt) <= now && now < new Date(s.endsAt),
  );
  const next = p.salePhases.find((s) => now < new Date(s.startsAt));
  const onSale = p.status === 'PUBLISHED' && open !== undefined;
  // With a waiting room, people may queue before the opening: their order
  // in line is kept, and they are admitted once the sale opens.
  const queueBeforeOpening =
    p.status === 'PUBLISHED' && p.waitingRoomEnabled && next !== undefined;
  const picker = (
    <SeatPicker performanceId={p.id} maxTickets={p.maxTicketsPerUser} />
  );

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
        <>
          <Alert>
            <AlertDescription>
              {next
                ? `Mở bán lúc ${formatDateTime(next.startsAt)}${next.type === 'PRESALE' ? ' (đợt bán trước, cần mã ưu tiên)' : ''}.`
                : 'Đêm diễn đã kết thúc bán vé.'}
            </AlertDescription>
          </Alert>
          {queueBeforeOpening && (
            <WaitingRoom performanceId={p.id}>{picker}</WaitingRoom>
          )}
        </>
      ) : (
        <>
          {open.type === 'PRESALE' && (
            <PresalePanel
              performanceId={p.id}
              salePhaseId={open.id}
              endsAt={open.endsAt}
            />
          )}
          {p.waitingRoomEnabled ? (
            <WaitingRoom performanceId={p.id}>{picker}</WaitingRoom>
          ) : (
            picker
          )}
        </>
      )}
    </div>
  );
}
