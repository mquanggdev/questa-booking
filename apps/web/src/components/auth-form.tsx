'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/lib/auth';

/** Only same-site paths: never redirect to another origin after login. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setBusy(true);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    try {
      if (mode === 'login') await login(email, password);
      else await register(String(form.get('fullName')), email, password);
      // `next` is a validated same-site path chosen at runtime.
      router.replace(next as never);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401
          ? 'Email hoặc mật khẩu không đúng.'
          : e instanceof ApiError && e.body.code === 'EMAIL_TAKEN'
            ? 'Email này đã được đăng ký.'
            : e instanceof Error
              ? e.message
              : 'Có lỗi xảy ra.',
      );
      setBusy(false);
    }
  }

  return (
    <form action={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">
        {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
      </h1>
      {mode === 'register' && (
        <div className="space-y-2">
          <Label htmlFor="fullName">Họ tên</Label>
          <Input id="fullName" name="fullName" required autoComplete="name" />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Mật khẩu</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === 'register' ? 8 : undefined}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {mode === 'login' ? (
          <>
            Chưa có tài khoản?{' '}
            <Link
              href={`/register?next=${encodeURIComponent(next)}`}
              className="underline"
            >
              Đăng ký
            </Link>
          </>
        ) : (
          <>
            Đã có tài khoản?{' '}
            <Link
              href={`/login?next=${encodeURIComponent(next)}`}
              className="underline"
            >
              Đăng nhập
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
