import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { OrderView } from './order-view';

export default function OrderPage({ params }: PageProps<'/orders/[id]'>) {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <Order params={params} />
    </Suspense>
  );
}

async function Order({
  params,
}: {
  params: PageProps<'/orders/[id]'>['params'];
}) {
  const { id } = await params;
  return <OrderView orderId={id} />;
}
