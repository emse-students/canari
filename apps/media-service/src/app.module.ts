import { Module } from '@nestjs/common';
import { MediaModule } from './media/media.module';
import { HealthController } from './health.controller';

@Module({
  imports: [MediaModule],
  controllers: [HealthController],
})
export class AppModule {}
