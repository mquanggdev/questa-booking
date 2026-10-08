'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, call } from '@/lib/api/client';
import { formatVnd } from '@/lib/format';

type Outcome = 'success' | 'cancelled' | 'failed';

/**
 * The local fake gateway's payment page, standing in for VNPay's. The
 * buttons make the API sign an IPN exactly like VNPay would and deliver it;
 * then the browser goes to the return URL, as with the real gateway.
 */
export function FakeGateway() {
  const txnRef = useSearchParams().get('txnRef') ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, error: loadError } = useQuery({
    queryKey: ['fake-checkout', txnRef],
    queryFn: () =>
      call(
        api.GET('/api/v1/payments/fake/checkout', {
          params: { query: { txnRef } },
        }),
      ),
    enabled: txnRef !== '',
  });

  const complete = async (outcome: Outcome) => {
    setBusy(true);
    setError(null);
    try {
      const result = await call(
        api.POST('/api/v1/payments/fake/complete', {
          body: { txnRef, outcome },
        }),
      );
      window.location.assign(result.returnUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi cổng thanh toán');
      setBusy(false);
    }
  };

  if (loadError) return <p>Không tìm thấy giao dịch.</p>;
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="mx-auto max-w-md space-y-6 rounded-xl border-2 border-dashed border-indigo-300 p-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">
          Cổng thanh toán giả lập
        </p>
        <h1 className="text-xl font-semibold">Xác nhận thanh toán</h1>
        <p className="text-sm text-muted-foreground">
          Không có tiền thật. Cổng này nói đúng giao thức VNPay (tham số, chữ ký
          HMAC-SHA512).
        </p>
      </div>
      <div className="space-y-1">
        <div className="text-sm text-muted-foreground">Số tiền</div>
        <div className="text-3xl font-bold">{formatVnd(data.amount)}</div>
        <code className="text-xs text-muted-foreground">
          Mã giao dịch {txnRef}
        </code>
      </div>
      {data.paymentStatus !== 'PENDING' && (
        <Alert>
          <AlertDescription>
            Giao dịch này đã được xử lý ({data.paymentStatus}).
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Button onClick={() => complete('success')} disabled={busy}>
          Thanh toán thành công
        </Button>
        <Button
          variant="outline"
          onClick={() => complete('cancelled')}
          disabled={busy}
        >
          Hủy giao dịch
        </Button>
        <Button
          variant="ghost"
          onClick={() => complete('failed')}
          disabled={busy}
        >
          Giả lập: thẻ không đủ tiền
        </Button>
      </div>
    </div>
  );
}
