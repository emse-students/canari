import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(Number(process.env.PORT || 3005));
}

void bootstrap().catch((err) => {
  console.error('Failed to bootstrap channel-service:', err);
  process.exit(1);
});
