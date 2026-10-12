import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO across several API replicas (phase 7a). Each replica only holds
 * its own sockets; the Redis adapter relays every broadcast through Redis
 * pub/sub, so a message emitted anywhere (another replica, or the worker
 * through @socket.io/redis-emitter) reaches clients connected to any replica.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapter?: ReturnType<typeof createAdapter>;
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    // Pub/sub needs two dedicated connections: one in subscriber mode
    // cannot run other commands.
    const pub = new Redis(this.redisUrl, { lazyConnect: true });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    this.clients.push(pub, sub);
    this.adapter = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    // Nest passes only the gateway's own options; socket.io fills the rest.
    const server = super.createIOServer(port, {
      ...options,
      // WebSocket only: long-polling would need sticky sessions, because its
      // successive HTTP requests must reach the same replica behind Nginx.
      transports: ['websocket'],
    } as ServerOptions);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
  }
}
