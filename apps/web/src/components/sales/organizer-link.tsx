'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

/** For organizers: the live sales dashboard of this performance. */
export function OrganizerLink({ performanceId }: { performanceId: string }) {
  const { user } = useAuth();
  if (user?.role !== 'ORGANIZER') return null;
  return (
    <Link
      href={`/performances/${performanceId}/sales`}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      Theo dõi mở bán
    </Link>
  );
}
