import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';

export const metadata = { title: 'Đăng nhập' };

export default function LoginPage() {
  // useSearchParams (the ?next= target) needs a Suspense boundary.
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}
