import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const allowedOrigins = new Set<string>(['http://tauri.localhost', 'https://tauri.localhost']);
  if (frontendUrl) allowedOrigins.add(frontendUrl);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
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
      // Deny CORS for unknown origins WITHOUT erroring. An Error here is not a
      // refusal, it is a THROW: Nest turns it into a 500 for the whole request,
      // even a public GET that needs no CORS at all - measured on prod
      // 2026-08-19, where GET /api/media/public/:id answered 500 to any request
      // carrying an Origin the allowlist did not know. `false` omits the CORS
      // headers instead, which is what actually blocks a credentialed browser
      // call while leaving the response itself correct for everything else.
      callback(null, false);
    },
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
