import Link from 'next/link';
import { Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { serverApi } from '@/lib/api/server';
import { formatDateTime } from '@/lib/format';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Concert đang mở bán</h1>
        <p className="text-muted-foreground">
          Chọn một đêm diễn để xem sơ đồ ghế và giữ vé.
        </p>
      </div>
      {/* The list is fetched per request (fresh availability), streamed in
          after the static shell. */}
      <Suspense fallback={<ConcertListSkeleton />}>
        <ConcertList />
      </Suspense>
    </div>
  );
}

async function ConcertList() {
  const { data, error } = await serverApi.GET('/api/v1/concerts', {
    params: { query: { page: 1, pageSize: 50 } },
  });
  if (error || !data) {
    return (
      <p className="text-destructive">Không tải được danh sách concert.</p>
    );
  }
  if (data.items.length === 0) {
    return <p className="text-muted-foreground">Chưa có concert nào.</p>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {data.items.map((concert) => (
        <Card key={concert.id}>
          <CardHeader>
            <CardTitle>
              <Link
                href={`/concerts/${concert.id}`}
                className="hover:underline"
              >
                {concert.name}
              </Link>
            </CardTitle>
            <CardDescription>{concert.artist}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {concert.performances.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2"
                >
                  <Link
                    href={`/performances/${p.id}`}
                    className="hover:underline"
                  >
                    {formatDateTime(p.startsAt)} · {p.venue}
                  </Link>
                  {p.status === 'CANCELLED' && (
                    <Badge variant="destructive">Đã hủy</Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ConcertListSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-40" />
      ))}
    </div>
  );
}
