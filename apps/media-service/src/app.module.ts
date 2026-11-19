import { Module } from '@nestjs/common';
import { MediaModule } from './media/media.module';
import { HealthController } from './health.controller';
import { ROUTE_PARAMS_GUARD } from './common/route-params';

@Module({
  imports: [MediaModule],
  controllers: [HealthController],
  providers: [ROUTE_PARAMS_GUARD],
})
export class AppModule {}
