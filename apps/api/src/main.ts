import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { AppConfigService } from './config/app-config.service.js';
import { RedisIoAdapter } from './redis/redis-io.adapter.js';

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
  await app.listen(port, '0.0.0.0');
}

await bootstrap();
