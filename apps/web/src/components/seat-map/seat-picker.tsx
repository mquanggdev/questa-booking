'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api, call, type Schemas } from '@/lib/api/client';
import { useAuth } from '@/lib/auth';
import { formatVnd } from '@/lib/format';
import { SEAT_COLORS } from './seat-colors';

type Seat = Schemas['SeatResponseDto'];

// Konva draws on <canvas> and needs `window`: load it in the browser only.
const SeatMapCanvas = dynamic(() => import('./seat-map-canvas'), {
  ssr: false,
  loading: () => <Skeleton className="h-80 w-full" />,
});

const ERROR_TEXT: Record<string, string> = {
  SEAT_UNAVAILABLE:
    'Một số ghế vừa có người khác giữ. Sơ đồ đã được cập nhật, hãy chọn ghế khác.',
  SOLD_OUT: 'Khu đứng không còn đủ vé.',
  TICKET_LIMIT_REACHED: 'Bạn đã giữ hoặc mua đủ số vé tối đa cho đêm diễn này.',
  TOO_MANY_TICKETS: 'Bạn chọn quá số vé tối đa cho một lần mua.',
  SALE_NOT_OPEN: 'Đêm diễn này hiện không mở bán.',
  SERVICE_UNAVAILABLE: 'Hệ thống đang quá tải. Vui lòng thử lại sau vài giây.',
};

export function SeatPicker({
  performanceId,
  maxTickets,
}: {
  performanceId: string;
  maxTickets: number;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [standing, setStanding] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One Idempotency-Key per purchase attempt: a retry of the same selection
  // (double click, flaky network) returns the same order instead of a second.
  const attempt = useRef<{ selection: string; key: string } | null>(null);

  const seatMapKey = ['seat-map', performanceId];
  const { data: map, isLoading } = useQuery({
    queryKey: seatMapKey,
    queryFn: () =>
      call(
        api.GET('/api/v1/performances/{id}/seats', {
          params: { path: { id: performanceId } },
        }),
      ),
    // Until the realtime WebSocket arrives (phase 7a), poll.
    refetchInterval: 5_000,
  });

  const zones = map?.zones ?? [];
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const seatById = new Map((map?.seats ?? []).map((s) => [s.id, s]));
  const standingCount = Object.values(standing).reduce((a, b) => a + b, 0);
  const count = selected.size + standingCount;
  const total =
    [...selected].reduce(
      (sum, id) =>
        sum + (zoneById.get(seatById.get(id)?.zoneId ?? '')?.price ?? 0),
      0,
    ) +
    Object.entries(standing).reduce(
      (sum, [zoneId, qty]) => sum + (zoneById.get(zoneId)?.price ?? 0) * qty,
      0,
    );

  const toggle = (seat: Seat) => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) next.delete(seat.id);
      else if (
        seat.status === 'AVAILABLE' &&
        prev.size + standingCount < maxTickets
      )
        next.add(seat.id);
      return next;
    });
  };

  const hold = async () => {
    setError(null);
    setSubmitting(true);
    const body = {
      performanceId,
      seatIds: [...selected].sort(),
      standing: Object.entries(standing)
        .filter(([, qty]) => qty > 0)
        .map(([zoneId, quantity]) => ({ zoneId, quantity })),
    };
    const selection = JSON.stringify(body);
    if (attempt.current?.selection !== selection) {
      attempt.current = { selection, key: crypto.randomUUID() };
    }
    try {
      const order = await call(
        api.POST('/api/v1/reservations', {
          params: { header: { 'Idempotency-Key': attempt.current.key } },
          body,
        }),
      );
      router.push(`/orders/${order.id}`);
    } catch (e) {
      const code = e instanceof ApiError ? e.body.code : '';
      setError(
        ERROR_TEXT[code] ??
          (e instanceof Error ? e.message : 'Lỗi không xác định'),
      );
      if (code === 'SEAT_UNAVAILABLE') {
        const taken = (e as ApiError).body.details as
          { seatIds?: string[] } | undefined;
        setSelected((prev) =>
          taken?.seatIds
            ? new Set([...prev].filter((id) => !taken.seatIds?.includes(id)))
            : new Set(),
        );
      }
      await queryClient.invalidateQueries({ queryKey: seatMapKey });
      setSubmitting(false);
    }
  };

  if (isLoading || !map) return <Skeleton className="h-96 w-full" />;

  const seatedZones = zones.filter((z) => z.type === 'SEATED');
  const standingZones = zones.filter((z) => z.type === 'STANDING');

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        {seatedZones.length > 0 && (
          <>
            <Legend />
            <SeatMapCanvas
              zones={zones}
              seats={map.seats}
              selected={selected}
              onToggle={toggle}
            />
            <p className="text-xs text-muted-foreground">
              Bấm vào ghế xanh để chọn. Kéo để di chuyển, cuộn chuột để phóng
              to.
            </p>
          </>
        )}
        {standingZones.map((zone) => {
          const qty = standing[zone.id] ?? 0;
          return (
            <div
              key={zone.id}
              className="flex items-center justify-between rounded-lg border p-4"
            >
              <div>
                <div className="font-medium">{zone.name} (vé đứng)</div>
                <div className="text-sm text-muted-foreground">
                  {formatVnd(zone.price)} · còn {zone.available} vé
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Bớt vé ${zone.name}`}
                  disabled={qty === 0}
                  onClick={() =>
                    setStanding({ ...standing, [zone.id]: qty - 1 })
                  }
                >
                  −
                </Button>
                <span
                  className="w-6 text-center tabular-nums"
                  aria-label={`Số vé ${zone.name}`}
                >
                  {qty}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Thêm vé ${zone.name}`}
                  disabled={count >= maxTickets || qty >= zone.available}
                  onClick={() =>
                    setStanding({ ...standing, [zone.id]: qty + 1 })
                  }
                >
                  +
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <aside className="h-fit space-y-4 rounded-lg border p-4 lg:sticky lg:top-4">
        <h2 className="font-semibold">Vé đã chọn</h2>
        <ul className="space-y-1 text-sm">
          {[...selected].map((id) => {
            const seat = seatById.get(id);
            return (
              <li key={id}>
                {zoneById.get(seat?.zoneId ?? '')?.name} · hàng {seat?.row} ghế{' '}
                {seat?.number}
              </li>
            );
          })}
          {standingZones
            .filter((z) => (standing[z.id] ?? 0) > 0)
            .map((z) => (
              <li key={z.id}>
                {z.name} × {standing[z.id]}
              </li>
            ))}
          {count === 0 && (
            <li className="text-muted-foreground">Chưa chọn vé nào.</li>
          )}
        </ul>
        <div className="flex justify-between border-t pt-3 font-medium">
          <span>Tổng</span>
          <span data-testid="selection-total">{formatVnd(total)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tối đa {maxTickets} vé mỗi tài khoản. Vé được giữ 10 phút để thanh
          toán.
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {status === 'anonymous' ? (
          <Link
            href={`/login?next=/performances/${performanceId}`}
            className={buttonVariants({ className: 'w-full' })}
          >
            Đăng nhập để giữ vé
          </Link>
        ) : (
          <Button
            className="w-full"
            disabled={count === 0 || submitting || status !== 'authenticated'}
            onClick={hold}
          >
            {submitting ? 'Đang giữ vé…' : `Giữ ${count} vé`}
          </Button>
        )}
      </aside>
    </div>
  );
}

function Legend() {
  const items = [
    ['Còn trống', SEAT_COLORS.available],
    ['Đang chọn', SEAT_COLORS.selected],
    ['Có người giữ', SEAT_COLORS.held],
    ['Đã bán', SEAT_COLORS.sold],
  ] as const;
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span
            className="inline-block size-3 rounded-full"
            style={{ background: color }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
