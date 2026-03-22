import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      },
      consumer: {
        groupId: 'chat-delivery-consumer',
      },
    },
  });

  app.setGlobalPrefix('api');
  app.enableCors();
  await app.startAllMicroservices();
  await app.listen(process.env.PORT || 3010);
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap application:', err);
  process.exit(1);
});
