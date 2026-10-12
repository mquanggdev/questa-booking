import { NestFactory } from '@nestjs/core';
import type { Server as HttpServer } from 'node:http';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { AppConfigService } from './config/app-config.service.js';
import { RedisIoAdapter } from './redis/redis-io.adapter.js';

const HTTP_LISTEN_BACKLOG = 4096;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  // Socket.IO across replicas: broadcasts are relayed through Redis.
  const ws = new RedisIoAdapter(
    app,
    app.get(AppConfigService).get('REDIS_URL'),
  );
  await ws.connect();
  app.useWebSocketAdapter(ws);

  const port = app.get(AppConfigService).get('PORT');
  // Accept queue of the listening socket. Node's default, 511, overflowed
  // at a sale's opening (2,000 buyers at once): the kernel dropped
  // connections, Nginx timed out connecting and marked healthy but busy
  // replicas as dead. The container's net.core.somaxconn is 4096; a full
  // queue now means waiting, not failing.
  // NestApplication.listen forwards its arguments to http.Server.listen
  // (port, host, backlog, callback); only its declared type omits backlog.
  const listen = app.listen.bind(app) as unknown as (
    port: number,
    host: string,
    backlog: number,
  ) => Promise<unknown>;
  await listen(port, '0.0.0.0', HTTP_LISTEN_BACKLOG);

  // Nginx keeps idle upstream connections open for 60 s (keepalive_timeout
  // in docker/nginx/default.conf). Node closed them after 5 s by default,
  // so Nginx sometimes sent a request on a socket Node was closing and got
  // a reset; with max_fails that took a healthy replica out of rotation.
  // The side that closes idle connections must be Nginx: Node waits longer.
  const server = app.getHttpServer() as HttpServer;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000; // must exceed keepAliveTimeout
}

await bootstrap();
