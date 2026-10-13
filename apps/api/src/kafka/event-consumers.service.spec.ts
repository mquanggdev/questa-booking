import type { AppConfigService } from '../config/app-config.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import type { OrderEvent } from '../modules/outbox/order-events.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  EventConsumersService,
  type OrderEventHandler,
} from './event-consumers.service.js';
import type { KafkaService } from './kafka.service.js';

const event: OrderEvent = {
  eventId: '01a13355-5a8e-7948-b51f-7fe9403434c9',
  eventType: 'order.paid',
  occurredAt: '2026-10-13T00:00:00.000Z',
  version: 1,
  data: {
    orderId: 'o1',
    userId: 'u1',
    performanceId: 'p1',
    totalAmount: 1,
    items: [],
  },
};

function setup(inserted: number) {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(inserted) };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const kafka = {
    send: vi.fn().mockResolvedValue(undefined),
    topics: { orders: 'orders.events', deadLetter: 'orders.events.dlq' },
  };
  const config = { get: () => 3 } as unknown as AppConfigService;
  const service = new EventConsumersService(
    kafka as unknown as KafkaService,
    prisma as unknown as PrismaService,
    config,
    new MetricsService(),
    [],
  );
  return { service, kafka, tx };
}

describe('EventConsumersService.handle', () => {
  it('applies a new event once and runs the after-commit step', async () => {
    const { service } = setup(1);
    const apply = vi.fn().mockResolvedValue(undefined);
    const afterCommit = vi.fn().mockResolvedValue(undefined);
    const handler: OrderEventHandler = { name: 'audit', apply, afterCommit };
    await expect(service.handle(handler, event)).resolves.toBe('applied');
    expect(apply).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it('a duplicate (processed_events already has it) does nothing', async () => {
    const { service } = setup(0);
    const apply = vi.fn();
    const afterCommit = vi.fn();
    const handler: OrderEventHandler = { name: 'audit', apply, afterCommit };
    await expect(service.handle(handler, event)).resolves.toBe('duplicate');
    expect(apply).not.toHaveBeenCalled();
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('retries, then sends the event to the dead letter topic with the reason', async () => {
    const { service, kafka } = setup(1);
    const apply = vi.fn().mockRejectedValue(new Error('foreign key violation'));
    const handler: OrderEventHandler = { name: 'analytics', apply };
    await expect(service.handle(handler, event)).resolves.toBe('dead-lettered');
    expect(apply).toHaveBeenCalledTimes(3);
    expect(kafka.send).toHaveBeenCalledWith('orders.events.dlq', [
      expect.objectContaining({
        key: 'o1',
        headers: expect.objectContaining({
          consumer: 'analytics',
          attempts: '3',
          error: expect.stringContaining('foreign key violation'),
        }),
      }),
    ]);
  });

  it('a failed after-commit step does not undo or repeat the effect', async () => {
    const { service } = setup(1);
    const apply = vi.fn().mockResolvedValue(undefined);
    const afterCommit = vi.fn().mockRejectedValue(new Error('redis down'));
    const handler: OrderEventHandler = {
      name: 'analytics',
      apply,
      afterCommit,
    };
    await expect(service.handle(handler, event)).resolves.toBe('applied');
    expect(apply).toHaveBeenCalledOnce();
  });

  it('if even the dead letter cannot be sent, it throws: Kafka delivers the message again', async () => {
    const { service, kafka } = setup(1);
    kafka.send.mockRejectedValue(new Error('kafka down'));
    const handler: OrderEventHandler = {
      name: 'analytics',
      apply: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(service.handle(handler, event)).rejects.toThrow('kafka down');
  });
});
