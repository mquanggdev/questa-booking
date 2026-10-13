import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * Prometheus metrics of one process (phase 9). Each process (and each test
 * app) has its own registry: the API replicas and the worker are scraped
 * separately and told apart by Prometheus' `instance` label.
 *
 * Process metrics (CPU, memory, event loop lag, GC) come from prom-client's
 * defaults, prefixed `questa_`.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** API: every HTTP request, by route template (not the raw URL). */
  readonly httpDuration = new Histogram({
    name: 'questa_http_request_duration_seconds',
    help: 'HTTP request duration, by method, route template and status',
    labelNames: ['method', 'route', 'status'] as const,
    // Holds take ~20 ms when healthy and seconds when overloaded.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** Worker: events sent to Kafka by the outbox relay. */
  readonly outboxPublished = new Counter({
    name: 'questa_outbox_published_total',
    help: 'Outbox events published to Kafka',
    registers: [this.registry],
  });

  /** Worker: what each consumer did with each delivery. */
  readonly consumerEvents = new Counter({
    name: 'questa_consumer_events_total',
    help: 'Order events per consumer and outcome (applied, duplicate, dead-lettered)',
    labelNames: ['consumer', 'outcome'] as const,
    registers: [this.registry],
  });

  /**
   * Worker: from the business change (occurredAt, the outbox row) to the
   * consumer having applied it: outbox wait + relay + Kafka + consumer.
   */
  readonly consumerLag = new Histogram({
    name: 'questa_consumer_lag_seconds',
    help: 'Seconds from an order event occurring to a consumer applying it',
    labelNames: ['consumer'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'questa_' });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  text(): Promise<string> {
    return this.registry.metrics();
  }
}
