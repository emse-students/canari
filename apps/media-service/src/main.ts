import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { buildAllowedOrigins, corsOptions } from './cors-origins';
import { drainOnSigterm } from './drain-on-sigterm';
import { MEDIA_EXPOSED_HEADERS } from './exposed-headers';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // what the estate lists in `ALLOW_ORIGIN` where it passes it (local and dev: the dev-server
  // pair). The list is exact and lives, with the predicate, in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL, process.env.ALLOW_ORIGIN);
  app.enableCors(corsOptions(allowedOrigins, MEDIA_EXPOSED_HEADERS));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3002);
  console.log(`[media-service] Listening on :${process.env.PORT ?? 3002}`);
  // A release stops this replica with SIGTERM before starting the next; see the module.
  drainOnSigterm(app.getHttpServer());
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap media-service:', err);
  process.exit(1);
});
