import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { serverApi } from '@/lib/api/server';
import { formatDateTime } from '@/lib/format';

export default function ConcertPage({ params }: PageProps<'/concerts/[id]'>) {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <ConcertDetail params={params} />
    </Suspense>
  );
}

async function ConcertDetail({
  params,
}: {
  params: PageProps<'/concerts/[id]'>['params'];
}) {
  const { id } = await params;
  const { data: concert } = await serverApi.GET('/api/v1/concerts/{id}', {
    params: { path: { id } },
  });
  if (!concert) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{concert.name}</h1>
        <p className="text-muted-foreground">{concert.artist}</p>
      </div>
      {concert.description && <p>{concert.description}</p>}
      <h2 className="text-lg font-semibold">Các đêm diễn</h2>
      <ul className="divide-y rounded-lg border">
        {concert.performances.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-4 p-4"
          >
            <div>
              <div className="font-medium">{formatDateTime(p.startsAt)}</div>
              <div className="text-sm text-muted-foreground">{p.venue}</div>
            </div>
            {p.status === 'CANCELLED' ? (
              <Badge variant="destructive">Đã hủy</Badge>
            ) : (
              <Link
                href={`/performances/${p.id}`}
                className="text-sm font-medium text-primary hover:underline"
              >
                Chọn vé →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
