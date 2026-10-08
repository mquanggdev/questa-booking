'use client';

import createClient from 'openapi-fetch';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type AuthResponse = Schemas['AuthResponseDto'];

/** Error body the API always returns: { code, message, details? }. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

// The access token lives in memory only (never localStorage, where any
// injected script could read it). After a reload it is recovered from the
// httpOnly refresh cookie, which JavaScript cannot read at all.
let accessToken: string | null = null;
const listeners = new Set<(auth: AuthResponse | null) => void>();

export function onAuthChange(listener: (auth: AuthResponse | null) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAuth(auth: AuthResponse | null): void {
  accessToken = auth?.accessToken ?? null;
  for (const listener of listeners) listener(auth);
}

let refreshing: Promise<AuthResponse | null> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Single-flight on
 * purpose: the API rotates refresh tokens and treats a reused one as stolen
 * (it revokes the whole family), so two concurrent refreshes would log the
 * user out. Every caller shares the one request in flight.
 */
export function refreshAuth(): Promise<AuthResponse | null> {
  const request = () =>
    fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then(async (res) =>
        res.ok ? ((await res.json()) as AuthResponse) : null,
      )
      .catch(() => null);
  // Across tabs too: a Web Lock queues the refreshes, so the second tab sends
  // the cookie the first one just received instead of the rotated-out one.
  refreshing ??= (
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('questa-auth-refresh', request)
      : request()
  )
    .then((auth) => {
      setAuth(auth);
      return auth;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** fetch with the bearer token; on 401, refreshes once and retries. */
async function authFetch(request: Request): Promise<Response> {
  const retry = request.clone();
  const send = (req: Request) => {
    if (accessToken) req.headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(req);
  };
  const response = await send(request);
  if (response.status !== 401 || request.url.includes('/auth/')) {
    return response;
  }
  return (await refreshAuth()) ? send(retry) : response;
}

/** Typed client generated from the API's OpenAPI document. */
export const api = createClient<paths>({ fetch: authFetch });

/** Unwraps an openapi-fetch result: the data, or a thrown ApiError. */
export async function call<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok) {
    const body = (error ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(response.status, {
      code: body.code ?? `HTTP_${response.status}`,
      message: body.message ?? response.statusText,
      details: body.details,
    });
  }
  return data as T;
}
