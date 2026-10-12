import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';

/**
 * Sends Socket.IO events from a process that serves no sockets (the worker):
 * the message goes through Redis, and every API replica's Redis adapter
 * delivers it to its own sockets in the room.
 *
 * @socket.io/redis-emitter calls `publish` without awaiting or catching it,
 * so a Redis error would surface as an unhandled rejection, which ends a
 * Node process. Here the emitter publishes through a shim, and emit()
 * returns that publish's promise: callers await it and handle failures.
 */
export class RedisEventPublisher {
  private readonly emitter: Emitter;
  private lastPublish: Promise<unknown> = Promise.resolve();

  constructor(redis: Redis, namespace: string) {
    this.emitter = new Emitter({
      // Called synchronously inside emit(), so emit() below always reads
      // the promise of its own message.
      publish: (channel: string, message: Buffer) =>
        (this.lastPublish = redis.publish(channel, message)),
    }).of(namespace);
  }

  async emit(room: string, event: string, payload: unknown): Promise<void> {
    this.emitter.to(room).emit(event, payload);
    await this.lastPublish;
  }
}
