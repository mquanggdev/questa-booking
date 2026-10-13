'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import {
  api,
  call,
  currentAccessToken,
  refreshAuth,
  type Schemas,
} from '@/lib/api/client';

export type SalesStats = Schemas['SalesStatsDto'];

/**
 * The organizer's live sales numbers (phase 8). GET /stats gives the
 * snapshot; the /sales WebSocket pushes `sales.updated` after every sale
 * or reversal (analytics consumer). Held tickets and the queue change
 * with every hold, without an event: a slow poll keeps them fresh.
 */
export function useSalesStats(performanceId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = ['sales', performanceId];
  const [connected, setConnected] = useState(false);
  const [lastPush, setLastPush] = useState<Date | null>(null);

  const stats = useQuery({
    queryKey,
    enabled,
    queryFn: () =>
      call(
        api.GET('/api/v1/performances/{id}/stats', {
          params: { path: { id: performanceId } },
        }),
      ),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!enabled) return;
    const socket = io('/sales', {
      transports: ['websocket'],
      auth: (cb) => cb({ token: currentAccessToken() }),
    });
    socket.on('connect', async () => {
      try {
        const snapshot = (await socket.emitWithAck('join', {
          performanceId,
        })) as SalesStats;
        queryClient.setQueryData(queryKey, snapshot);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    });
    socket.on('exception', async () => {
      setConnected(false);
      if (await refreshAuth()) socket.disconnect().connect();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('sales.updated', (snapshot: SalesStats) => {
      if (snapshot.performanceId !== performanceId) return;
      queryClient.setQueryData(queryKey, snapshot);
      setLastPush(new Date());
    });
    return () => {
      socket.disconnect();
    };
    // queryKey is derived from performanceId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performanceId, enabled, queryClient]);

  return { stats: stats.data, error: stats.error, connected, lastPush };
}
