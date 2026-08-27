import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import { buildAllowedOrigins, corsOriginDelegate } from './cors-origins';

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

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // http(s) loopback on any port for dev. The list and the predicate live in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL);
  app.enableCors({
    origin: corsOriginDelegate(allowedOrigins),
    credentials: true,
    /**
     * Without this the browser hides the header from the very clients that need it most: the app
     * runs cross-origin under Tauri, so a response header it cannot read would silently disable
     * the history walk's upper bound on mobile ONLY - the shape of failure that compiles, deploys
     * green, and is wrong.
     */
    exposedHeaders: ['X-History-Head'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.startAllMicroservices();
  await app.listen(process.env.PORT || 3010);
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap application:', err);
  process.exit(1);
});
