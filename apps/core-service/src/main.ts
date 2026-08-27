import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { buildAllowedOrigins, corsOriginDelegate } from './cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(cookieParser());

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // http(s) loopback on any port for dev. The list and the predicate live in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL);
  app.enableCors({
    origin: corsOriginDelegate(allowedOrigins),
    credentials: true,
  });

  // Allow Stripe to send raw body for webhook verification on this specific route
  const webhookPath = '/api/payments/webhook';
  app.use(webhookPath, bodyParser.raw({ type: 'application/json' }) as any);

  // Increase payload limit to accommodate base64 background images for posters
  app.use(bodyParser.json({ limit: '15mb' }));
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));

  await app.listen(process.env.PORT ?? 3012);
}
void bootstrap();
