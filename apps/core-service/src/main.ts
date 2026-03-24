import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  // Allow Stripe to send raw body for webhook verification on this specific route
  const webhookPath = '/api/payments/webhook';
  app.use(webhookPath, bodyParser.raw({ type: 'application/json' }));

  await app.listen(process.env.PORT ?? 3004);
}
void bootstrap();
