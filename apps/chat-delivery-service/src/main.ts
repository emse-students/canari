import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import { buildAllowedOrigins, corsOptions } from './cors-origins';
import { drainOnSigterm } from './drain-on-sigterm';
import { joinAskAnnouncementsSettled } from './utils/join-ask-announce';

/**
 * THIS SERVICE CONNECTS NO KAFKA TRANSPORT, AND NEITHER DOES ANY OTHER - THERE IS NO BROKER.
 *
 * It used to call `connectMicroservice({ transport: Transport.KAFKA })`, and it has never had a
 * single `@MessagePattern` or `@EventPattern` handler. Nest's `ServerKafka` still created and
 * connected a producer for handler REPLIES, whose only send path is a reply to a handler that does
 * not exist - so it could never emit a record, and its creation printed the KafkaJS partitioner
 * warning on every boot. Measured on prod 2026-08-31: the broker held only `__consumer_offsets`,
 * and the sole consumer group was this service's own, subscribed to nothing.
 *
 * `KAFKAJS_NO_PARTITIONER_WARNING=1` would have hidden the line while leaving the producer; the
 * producer went instead, and the same day so did the broker - `chat-gateway`'s consumer was the
 * one remaining client and it subscribed to a topic no code has ever produced. Real-time fan-out
 * in this system is Redis pub/sub, which delivers to named recipients; see
 * `docs/wiki/services/chat-gateway.md`.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(bodyParser.json({ limit: '10mb' }));

  app.setGlobalPrefix('api');

  // Allowed origins: every Tauri WebView origin (one per platform), the deployed frontend, and
  // http(s) loopback on any port for dev. The list and the predicate live in `cors-origins.ts`.
  const allowedOrigins = buildAllowedOrigins(process.env.FRONTEND_URL);
  /**
   * `X-History-Head` exposed: without it the browser hides the header from the very clients that
   * need it most: the app runs cross-origin under Tauri, so a response header it cannot read would
   * silently disable the history walk's upper bound on mobile ONLY - the shape of failure that
   * compiles, deploys green, and is wrong.
   */
  app.enableCors(corsOptions(allowedOrigins, ['X-History-Head']));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT || 3010);
  // A release retires this replica with SIGTERM once its successor is healthy; see the module. The
  // join-ask announcements started after an answer are finished before the process leaves.
  drainOnSigterm(app.getHttpServer(), undefined, undefined, joinAskAnnouncementsSettled);
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap application:', err);
  process.exit(1);
});
