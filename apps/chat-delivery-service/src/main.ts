import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      },
      consumer: {
        groupId: 'chat-delivery-consumer',
      },
    },
  });

  app.use(bodyParser.json({ limit: '10mb' }));

  app.setGlobalPrefix('api');

  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const allowedOrigins = new Set<string>([
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]);
  if (frontendUrl) allowedOrigins.add(frontendUrl);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.startAllMicroservices();
  await app.listen(process.env.PORT || 3010);
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap application:', err);
  process.exit(1);
});
