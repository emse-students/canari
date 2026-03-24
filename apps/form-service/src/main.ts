import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const logger = new Logger('FormService');
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({
    origin: '*', // Adjust as needed
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3008); // Using 3008 for form-service

  // Allow Stripe to send raw body for webhook verification on this specific route
  const webhookPath = '/api/forms/webhook';
  app.use(webhookPath, bodyParser.raw({ type: 'application/json' }));

  await app.listen(port);
  logger.log(`Form service is running on port ${port}`);
}

void bootstrap().catch((err) => {
  new Logger('Bootstrap').error('Failed to bootstrap form-service:', err);
  process.exit(1);
});
