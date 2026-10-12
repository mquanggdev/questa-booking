'use client';

import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { applyBatches, type SeatMap, type SeatsBatch } from './seat-sync';

/** Batches kept to re-apply on top of a snapshot that arrives late. */
const KEEP = 200;

/**
 * Keeps the cached seat map (TanStack Query, `queryKey`) up to date over the
 * WebSocket `/seats` namespace (phase 7a).
 *
 * Every received batch is kept for a while, and the cache is always "latest
 * snapshot + kept batches with a greater seq". That also covers a snapshot
 * request that started before a batch was applied but returned after it:
 * re-applying the kept batches brings it forward instead of going back.
 * A gap in seq, or a reconnect, triggers a fresh snapshot.
 */
export function useRealtimeSeatMap(performanceId: string, queryKey: QueryKey) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<{
    connected: boolean;
    instance: string | null;
  }>({
    connected: false,
    instance: null,
  });

  useEffect(() => {
    const recent: SeatsBatch[] = [];
    const reload = () => void queryClient.invalidateQueries({ queryKey });

    const sync = () => {
      const current = queryClient.getQueryData<SeatMap>(queryKey);
      if (!current) return; // no snapshot yet: the batches wait in `recent`
      const result = applyBatches(current, recent);
      if (result.map !== current)
        queryClient.setQueryData(queryKey, result.map);
      if (result.reload) reload();
    };

    // Same origin: Nginx forwards /socket.io to the API replicas. WebSocket
    // only, so no sticky sessions are needed behind the load balancer.
    const socket = io('/seats', { transports: ['websocket'] });
    socket.on('connect', async () => {
      const ack = (await socket.emitWithAck('join', { performanceId })) as {
        instance: string;
        seq: number;
      };
      setStatus({ connected: true, instance: ack.instance });
      // While disconnected anything may have happened: if the server is
      // ahead of our snapshot, start again from a fresh one.
      const current = queryClient.getQueryData<SeatMap>(queryKey);
      if (!current || ack.seq > current.seq) reload();
    });
    socket.on('disconnect', () =>
      setStatus((s) => ({ ...s, connected: false })),
    );
    socket.on('seats.batch', (batch: SeatsBatch) => {
      recent.push(batch);
      if (recent.length > KEEP) recent.shift();
      sync();
    });

    // A fetched snapshot (not our own setQueryData) may be behind the
    // batches already applied: bring it forward.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        !event.action.manual &&
        event.query.queryHash === JSON.stringify(queryKey)
      ) {
        sync();
      }
    });

    return () => {
      unsubscribe();
      socket.disconnect();
    };
    // queryKey is derived from performanceId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performanceId, queryClient]);

  return status;
}
