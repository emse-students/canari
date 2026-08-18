import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformAnnouncement } from './entities/platform-announcement.entity';
import { PlatformAnnouncementSeen } from './entities/platform-announcement-seen.entity';
import { PlatformService } from './platform.service';
import { AnnouncementService } from './announcement.service';
import { PlatformAdminController } from './platform-admin.controller';
import { AnnouncementController } from './announcement.controller';

/** Platform-wide settings (maintenance mode, minimum client version) and the admin announcement. */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlatformConfig, PlatformAnnouncement, PlatformAnnouncementSeen]),
  ],
  controllers: [PlatformAdminController, AnnouncementController],
  providers: [PlatformService, AnnouncementService],
  exports: [PlatformService],
})
export class PlatformModule {}
