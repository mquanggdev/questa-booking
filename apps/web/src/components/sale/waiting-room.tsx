'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/lib/auth';
import { formatWait } from './queue-state';
import { useWaitingRoom } from './use-waiting-room';

const JOIN_ERRORS: Record<string, string> = {
  SALE_NOT_OPEN: 'Đêm diễn không còn đợt bán nào.',
  WAITING_ROOM_DISABLED: 'Đêm diễn này không dùng hàng chờ. Hãy tải lại trang.',
};

/**
 * Shows `children` (the seat picker) only once the buyer is admitted from
 * the virtual waiting room. People still waiting do not load the seat map
 * at all, which is part of what the line protects.
 */
export function WaitingRoom({
  performanceId,
  children,
}: {
  performanceId: string;
  children: React.ReactNode;
}) {
  const { status: auth, user } = useAuth();
  // Only customers queue (the API refuses other roles).
  const isCustomer = user?.role === 'CUSTOMER';
  const room = useWaitingRoom(
    performanceId,
    auth === 'authenticated' && isCustomer,
  );
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  if (auth === 'anonymous') {
    return (
      <Alert>
        <AlertDescription className="space-y-3">
          <p>
            Đêm diễn này dùng hàng chờ ảo: mọi người xếp hàng theo thứ tự đến,
            và được vào chọn vé theo từng đợt.
          </p>
          <Link
            href={`/login?next=/performances/${performanceId}`}
            className={buttonVariants()}
          >
            Đăng nhập để vào hàng chờ
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  if (auth === 'authenticated' && !isCustomer) {
    // Organizers do not queue; they see the seat map like on any other
    // performance (read-only: the picker hides its hold button for them).
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            Đêm diễn này dùng hàng chờ ảo: khách mua vé xếp hàng trước khi thấy
            sơ đồ ghế. Ban tổ chức không cần xếp hàng; số người đang chờ hiện ở
            trang &quot;Theo dõi mở bán&quot;.
          </AlertDescription>
        </Alert>
        {children}
      </div>
    );
  }
  if (auth === 'loading' || room.isLoading || !room.status) {
    return <Skeleton className="h-32 w-full" />;
  }

  const s = room.status;
  if (s.status === 'NOT_REQUIRED') return children;
  if (s.status === 'ADMITTED' && s.expiresAt) {
    return (
      <div className="space-y-4">
        <PassBanner expiresAt={s.expiresAt} onExpired={room.refresh} />
        {children}
      </div>
    );
  }

  const join = async () => {
    setError(null);
    setJoining(true);
    try {
      await room.join();
    } catch (e) {
      const code = e instanceof ApiError ? e.body.code : '';
      setError(JOIN_ERRORS[code] ?? 'Không vào được hàng chờ. Hãy thử lại.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div
      className="space-y-4 rounded-lg border p-6"
      data-testid="waiting-room"
      data-status={s.status}
    >
      <h2 className="text-lg font-semibold">Hàng chờ ảo</h2>
      {s.status === 'WAITING' ? (
        <>
          <p className="text-3xl font-semibold tabular-nums">
            Vị trí {s.position}
            <span className="ml-2 text-base font-normal text-muted-foreground">
              / {s.waiting} người đang chờ
            </span>
          </p>
          <p className="text-muted-foreground">
            Thời gian chờ dự kiến: {formatWait(s.estimatedWaitSeconds)}. Hãy giữ
            trang này mở, trang sẽ tự chuyển khi đến lượt bạn.
          </p>
          <p className="text-xs text-muted-foreground">
            {room.connected ? '● Cập nhật trực tiếp' : '○ Đang kết nối lại…'}
          </p>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Mọi người xếp hàng theo thứ tự đến và được vào chọn vé theo từng
            đợt. Vào hàng trước giờ mở bán vẫn giữ nguyên thứ tự của bạn.
          </p>
          <Button onClick={join} disabled={joining}>
            {joining ? 'Đang vào hàng…' : 'Vào hàng chờ'}
          </Button>
        </>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PassBanner({
  expiresAt,
  onExpired,
}: {
  expiresAt: string;
  onExpired: () => void;
}) {
  const end = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => end - Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      const ms = end - Date.now();
      setLeft(ms);
      if (ms <= 0) {
        clearInterval(timer);
        onExpired();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [end, onExpired]);
  const seconds = Math.max(Math.ceil(left / 1000), 0);
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <Alert data-testid="queue-pass">
      <AlertDescription>
        Đến lượt bạn! Bạn có{' '}
        <span className="font-semibold tabular-nums">{mmss}</span> để giữ vé. Vé
        đã giữ vẫn được giữ 10 phút để thanh toán.
      </AlertDescription>
    </Alert>
  );
}
