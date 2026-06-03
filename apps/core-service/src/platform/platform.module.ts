import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformService } from './platform.service';
import { PlatformAdminController } from './platform-admin.controller';

/** Platform-wide settings (maintenance mode, minimum client version). */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformConfig])],
  controllers: [PlatformAdminController],
  providers: [PlatformService],
  exports: [PlatformService],
})
export class PlatformModule {}
