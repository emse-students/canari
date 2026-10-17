import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { buildAllowedOrigins, corsOptions } from './cors-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // http(s) loopback on any port for dev. The list and the predicate live in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL);
  /**
   * The phone apps read Canari's API through the WebView's own `fetch` (`fetchRouting.ts`), so
   * they are a cross-origin client: a response header the browser does not expose is `null` to
   * them. The XLSX exports name their file in `Content-Disposition` (`downloadXlsxFromApi`).
   */
  app.enableCors(corsOptions(allowedOrigins, ['Content-Disposition']));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.use(bodyParser.json({ limit: '15mb' }));
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));

  await app.listen(Number(process.env.PORT || 3014));
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap social-service:', err);
  process.exit(1);
});
