import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { SalesView } from './sales-view';

export default function SalesPage({
  params,
}: PageProps<'/performances/[id]/sales'>) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Sales params={params} />
    </Suspense>
  );
}

async function Sales({
  params,
}: {
  params: PageProps<'/performances/[id]/sales'>['params'];
}) {
  const { id } = await params;
  return <SalesView performanceId={id} />;
}
