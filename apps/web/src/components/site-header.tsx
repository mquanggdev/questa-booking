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
          {/* Orders and tickets are a customer's (the API refuses other roles). */}
          {user?.role === 'CUSTOMER' && (
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
              {user.isDemo && (
                <span
                  className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground"
                  title="Tài khoản ban tổ chức dùng chung của bản demo: xem được mọi trang, không thay đổi được gì"
                >
                  Demo · chỉ xem
                </span>
              )}
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
