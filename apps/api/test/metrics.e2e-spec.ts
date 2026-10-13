import type { INestApplicationContext } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { WorkerMetricsService } from '../src/metrics/worker-metrics.service.js';
import {
  createTestApp,
  createTestWorker,
  type TestApp,
} from './support/app.js';

/** Phase 9: what Prometheus scrapes from the API replicas and the worker. */
describe('Metrics (e2e)', () => {
  let t: TestApp;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    t = await createTestApp();
    worker = await createTestWorker({
      KAFKA_TOPIC_PREFIX: `e2e-metrics-${Date.now()}.`,
    });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
  });

  it('the API counts requests by route template, not by raw URL', async () => {
    await t.http().get('/api/v1/health').expect(200);
    await t
      .http()
      .get('/api/v1/performances/01a13380-19ab-7c8f-aed1-cdd05a451d5e')
      .expect(404);
    const res = await t.http().get('/api/v1/metrics').expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain(
      'questa_http_request_duration_seconds_count{method="GET",route="/api/v1/health",status="200"}',
    );
    // The id does not become a label (one series per route, not per id).
    expect(res.text).toContain('route="/api/v1/performances/:id",status="404"');
    expect(res.text).not.toContain('01a13380-19ab');
    // Process metrics, e.g. the event loop lag.
    expect(res.text).toContain('questa_nodejs_eventloop_lag_seconds');
  });

  it('the worker serves its own /metrics: outbox, queues, consumers', async () => {
    const server = (
      worker.get(WorkerMetricsService) as unknown as {
        server: { address(): AddressInfo };
      }
    ).server;
    const port = server.address().port;
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    for (const name of [
      'questa_outbox_unpublished',
      'questa_outbox_oldest_unpublished_age_seconds',
      'questa_queue_jobs{queue="reservations",state="delayed"}',
      'questa_waiting_room_people',
      'questa_consumer_lag_seconds',
      'questa_outbox_published_total',
    ]) {
      expect(text).toContain(name);
    }
  });
});
