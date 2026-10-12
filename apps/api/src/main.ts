import { NestFactory } from '@nestjs/core';
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
}

await bootstrap();
