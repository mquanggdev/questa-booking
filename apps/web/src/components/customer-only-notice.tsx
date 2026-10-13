import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Orders and tickets belong to customers: the API answers 403 to any other
 * role, so those pages show this instead of loading forever.
 */
export function CustomerOnlyNotice() {
  return (
    <Alert>
      <AlertDescription>
        Trang này dành cho tài khoản khách mua vé. Ban tổ chức theo dõi doanh số
        ở trang &quot;Theo dõi mở bán&quot; của từng đêm diễn.{' '}
        <Link href="/">Xem concert</Link>
      </AlertDescription>
    </Alert>
  );
}
