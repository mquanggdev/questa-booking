import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createServer, type Server } from 'node:http';
import { Gauge } from 'prom-client';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PAYMENTS_DEAD_LETTER_QUEUE,
  PAYMENTS_QUEUE,
  RESERVATIONS_QUEUE,
  WAITING_ROOM_QUEUE,
} from '../queue/queue.constants.js';
import { WaitingRoomKey } from '../modules/waiting-room/waiting-room.constants.js';
import { REDIS } from '../redis/redis.module.js';
import { MetricsService } from './metrics.service.js';

/**
 * The worker's metrics (phase 9): gauges read when Prometheus scrapes, and
 * a small HTTP server for /metrics (the worker serves no other HTTP).
 */
@Injectable()
export class WorkerMetricsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerMetricsService.name);
  private server?: Server;

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(RESERVATIONS_QUEUE) reservations: Queue,
    @InjectQueue(PAYMENTS_QUEUE) payments: Queue,
    @InjectQueue(PAYMENTS_DEAD_LETTER_QUEUE) deadLetters: Queue,
    @InjectQueue(WAITING_ROOM_QUEUE) waitingRoom: Queue,
  ) {
    const registers = [metrics.registry];
    const queues = [reservations, payments, deadLetters, waitingRoom];

    // Each gauge has its own collect(): one query per gauge per scrape.
    new Gauge({
      name: 'questa_outbox_unpublished',
      help: 'Outbox events not yet published to Kafka',
      registers,
      collect: async function () {
        const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL
        `;
        this.set(Number(row?.n ?? 0));
      },
    });
    new Gauge({
      name: 'questa_outbox_oldest_unpublished_age_seconds',
      help: 'Age of the oldest unpublished outbox event (0 when none)',
      registers,
      collect: async function () {
        const [row] = await prisma.$queryRaw<{ age: number | null }[]>`
          SELECT extract(epoch FROM now() - min(created_at))::float8 AS age
          FROM outbox_events WHERE published_at IS NULL
        `;
        this.set(row?.age ?? 0);
      },
    });
    new Gauge({
      name: 'questa_queue_jobs',
      help: 'BullMQ jobs per queue and state',
      labelNames: ['queue', 'state'] as const,
      registers,
      collect: async function () {
        for (const queue of queues) {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
          );
          for (const [state, n] of Object.entries(counts)) {
            this.set({ queue: queue.name, state }, n);
          }
        }
      },
    });
    new Gauge({
      name: 'questa_waiting_room_people',
      help: 'People waiting in virtual waiting rooms (all performances)',
      registers,
      collect: async function () {
        const active = await redis.smembers(WaitingRoomKey.active);
        let total = 0;
        for (const id of active) {
          total += await redis.zcard(WaitingRoomKey.line(id));
        }
        this.set(total);
      },
    });
  }

  onApplicationBootstrap(): void {
    const port = this.config.get('METRICS_PORT');
    this.server = createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.metrics
        .text()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': this.metrics.contentType() });
          res.end(body);
        })
        .catch((error: unknown) => {
          this.logger.warn(`Metrics scrape failed: ${String(error)}`);
          res.writeHead(500).end();
        });
    });
    // A busy port must not take the worker down: it only loses /metrics.
    this.server.on('error', (error) =>
      this.logger.warn(`Metrics server not started: ${String(error)}`),
    );
    this.server.listen(port, '0.0.0.0');
  }

  onApplicationShutdown(): void {
    this.server?.close();
  }
}
