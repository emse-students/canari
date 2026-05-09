import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const allowedOrigins = new Set<string>([
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]);
  if (frontendUrl) allowedOrigins.add(frontendUrl);
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) { callback(null, true); return; }
      if (allowedOrigins.has(origin)) { callback(null, true); return; }
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) { callback(null, true); return; }
      if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) { callback(null, true); return; }
      callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(Number(process.env.PORT || 3014));
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap social-service:', err);
  process.exit(1);
});
