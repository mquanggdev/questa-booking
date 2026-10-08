import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { PaymentResult } from './payment-result';

export const metadata = { title: 'Kết quả thanh toán' };

export default function PaymentResultPage({
  params,
}: PageProps<'/checkout/result/[provider]'>) {
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <Result params={params} />
    </Suspense>
  );
}

async function Result({
  params,
}: {
  params: PageProps<'/checkout/result/[provider]'>['params'];
}) {
  const { provider } = await params;
  return <PaymentResult provider={provider} />;
}
