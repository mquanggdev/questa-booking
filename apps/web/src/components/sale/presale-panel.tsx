'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api, call } from '@/lib/api/client';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

const ERRORS: Record<string, string> = {
  PRESALE_CODE_INVALID: 'Mã không đúng hoặc không dành cho đêm diễn này.',
  PRESALE_CODE_USED: 'Mã này đã được người khác sử dụng.',
  PRESALE_ALREADY_REDEEMED:
    'Tài khoản của bạn đã kích hoạt một mã cho đợt bán trước này rồi.',
  PRESALE_CLOSED: 'Đợt bán trước đã kết thúc.',
  VALIDATION_FAILED: 'Mã gồm 10 chữ và số, ví dụ K7QM-2XRP-9D.',
  TOO_MANY_REQUESTS: 'Bạn thử quá nhiều lần. Vui lòng đợi một phút.',
};

/** During a PRESALE phase: redeem a presale code before holding tickets. */
export function PresalePanel({
  performanceId,
  salePhaseId,
  endsAt,
}: {
  performanceId: string;
  salePhaseId: string;
  endsAt: string;
}) {
  const { status: auth } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['presale', performanceId];
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const mine = useQuery({
    queryKey,
    enabled: auth === 'authenticated',
    queryFn: () =>
      call(
        api.GET('/api/v1/performances/{id}/presale/me', {
          params: { path: { id: performanceId } },
        }),
      ),
  });
  const redeemed = mine.data?.some((r) => r.salePhaseId === salePhaseId);

  const redeem = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSending(true);
    try {
      await call(
        api.POST('/api/v1/performances/{id}/presale/redeem', {
          params: { path: { id: performanceId } },
          body: { code },
        }),
      );
      await queryClient.invalidateQueries({ queryKey });
    } catch (e) {
      const errorCode = e instanceof ApiError ? e.body.code : '';
      setError(ERRORS[errorCode] ?? 'Không kích hoạt được mã. Hãy thử lại.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      data-testid="presale-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Đợt bán trước</h2>
        <span className="text-sm text-muted-foreground">
          đến {formatDateTime(endsAt)}, chỉ dành cho tài khoản có mã ưu tiên
        </span>
        {redeemed && <Badge>Đã kích hoạt mã</Badge>}
      </div>
      {auth === 'anonymous' && (
        <p className="text-sm">
          <Link
            href={`/login?next=/performances/${performanceId}`}
            className="underline"
          >
            Đăng nhập
          </Link>{' '}
          để nhập mã ưu tiên.
        </p>
      )}
      {auth === 'authenticated' && !redeemed && !mine.isLoading && (
        <form onSubmit={redeem} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="presale-code">Mã ưu tiên</Label>
            <Input
              id="presale-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="K7QM-2XRP-9D"
              autoComplete="off"
              className="w-48 font-mono uppercase"
            />
          </div>
          <Button type="submit" disabled={sending || code.trim() === ''}>
            {sending ? 'Đang kích hoạt…' : 'Kích hoạt'}
          </Button>
        </form>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
