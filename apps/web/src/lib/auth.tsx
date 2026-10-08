'use client';

import { createContext, use, useEffect, useState } from 'react';
import {
  api,
  call,
  onAuthChange,
  refreshAuth,
  setAuth,
  type Schemas,
} from './api/client';

type User = Schemas['UserResponseDto'];

interface AuthState {
  /** 'loading' until the refresh cookie has been tried once. */
  status: 'loading' | 'anonymous' | 'authenticated';
  user: User | null;
  login(email: string, password: string): Promise<void>;
  register(fullName: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthChange((auth) => setUser(auth?.user ?? null));
    // A page load starts without an access token: recover the session from
    // the httpOnly refresh cookie, if there is one.
    void refreshAuth().finally(() => setReady(true));
    return () => {
      unsubscribe();
    };
  }, []);

  const login = async (email: string, password: string) => {
    setAuth(
      await call(api.POST('/api/v1/auth/login', { body: { email, password } })),
    );
  };

  const value: AuthState = {
    status: !ready ? 'loading' : user ? 'authenticated' : 'anonymous',
    user,
    login,
    async register(fullName, email, password) {
      await call(
        api.POST('/api/v1/auth/register', {
          body: { fullName, email, password },
        }),
      );
      await login(email, password);
    },
    async logout() {
      await api.POST('/api/v1/auth/logout').catch(() => undefined);
      setAuth(null);
    },
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
}
