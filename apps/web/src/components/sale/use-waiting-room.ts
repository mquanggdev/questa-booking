'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, call, currentAccessToken, refreshAuth } from '@/lib/api/client';
import {
  applyPosition,
  type QueuePositionEvent,
  type QueueStatus,
} from './queue-state';

/**
 * My place in a performance's virtual waiting room (phase 7b).
 *
 * The status comes from GET /queue/me and is kept live over the /queue
 * WebSocket: `queue.position` moves me forward, `queue.admitted` lets me
 * in. Without the socket, the status is polled when the server says
 * (pollAfterMs: rarely far back in line, every second near the front).
 */
export function useWaitingRoom(performanceId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = ['queue', performanceId];
  const [connected, setConnected] = useState(false);

  const status = useQuery({
    queryKey,
    enabled,
    queryFn: () =>
      call(
        api.GET('/api/v1/performances/{id}/queue/me', {
          params: { path: { id: performanceId } },
        }),
      ),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status !== 'WAITING') return false;
      // The socket pushes every change; polling is the safety net.
      return connected ? 30_000 : (data.pollAfterMs ?? 5000);
    },
  });

  useEffect(() => {
    if (!enabled) return;
    const set = (next: QueueStatus) => queryClient.setQueryData(queryKey, next);
    // Same origin through Nginx; WebSocket only (no sticky sessions). The
    // token is read at every (re)connect, so a refreshed one is used.
    const socket = io('/queue', {
      transports: ['websocket'],
      auth: (cb) => cb({ token: currentAccessToken() }),
    });
    socket.on('connect', async () => {
      try {
        set(
          (await socket.emitWithAck('join', { performanceId })) as QueueStatus,
        );
        setConnected(true);
      } catch {
        setConnected(false);
      }
    });
    // The access token expired while waiting: refresh it and reconnect.
    socket.on('exception', async () => {
      setConnected(false);
      if (await refreshAuth()) socket.disconnect().connect();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('queue.position', (event: QueuePositionEvent) => {
      if (event.performanceId !== performanceId) return;
      queryClient.setQueryData<QueueStatus>(queryKey, (prev) =>
        applyPosition(prev, event),
      );
    });
    socket.on(
      'queue.admitted',
      (event: { performanceId: string; expiresAt: string }) => {
        if (event.performanceId !== performanceId) return;
        set({ status: 'ADMITTED', expiresAt: event.expiresAt });
      },
    );
    return () => {
      socket.disconnect();
    };
    // queryKey is derived from performanceId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performanceId, enabled, queryClient]);

  const join = async () => {
    const next = await call(
      api.POST('/api/v1/performances/{id}/queue', {
        params: { path: { id: performanceId } },
      }),
    );
    queryClient.setQueryData(queryKey, next);
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  return {
    status: status.data,
    isLoading: status.isLoading,
    connected,
    join,
    refresh,
  };
}
