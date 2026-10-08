'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

export function SiteHeader() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
        <Link href="/" className="font-semibold">
          Questa
        </Link>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/">Concert</Link>
          {status === 'authenticated' && (
            <>
              <Link href="/orders">Đơn hàng</Link>
              <Link href="/tickets">Vé của tôi</Link>
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {status === 'authenticated' && user && (
            <>
              <span className="hidden text-muted-foreground sm:inline">
                {user.fullName}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await logout();
                  router.push('/');
                }}
              >
                Đăng xuất
              </Button>
            </>
          )}
          {status === 'anonymous' && (
            <>
              <Link href="/login">Đăng nhập</Link>
              <Link href="/register" className={buttonVariants({ size: 'sm' })}>
                Đăng ký
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
