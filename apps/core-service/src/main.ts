import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(cookieParser());

  // Allowed origins: production frontend + any localhost port (Tauri dev / local dev).
  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const allowedOrigins = new Set<string>([
    'http://tauri.localhost',
    'https://tauri.localhost', // Tauri v2 Android uses https scheme
  ]);
  if (frontendUrl) allowedOrigins.add(frontendUrl);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      // Always allow localhost on any port (Tauri desktop dev / prod builds)
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

  // Allow Stripe to send raw body for webhook verification on this specific route
  const webhookPath = '/api/payments/webhook';
  app.use(webhookPath, bodyParser.raw({ type: 'application/json' }) as any);

  // Increase payload limit to accommodate base64 background images for posters
  app.use(bodyParser.json({ limit: '15mb' }));
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));

  await app.listen(process.env.PORT ?? 3012);
}
void bootstrap();
