import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { buildAllowedOrigins, corsOriginDelegate } from './cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // http(s) loopback on any port for dev. The list and the predicate live in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL);
  app.enableCors({
    origin: corsOriginDelegate(allowedOrigins),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3002);
  console.log(`[media-service] Listening on :${process.env.PORT ?? 3002}`);
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap media-service:', err);
  process.exit(1);
});
