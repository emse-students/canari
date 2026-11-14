import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { PlatformAnnouncement } from './entities/platform-announcement.entity';
import { PlatformAnnouncementSeen } from './entities/platform-announcement-seen.entity';
import { HelpSeen } from './entities/help-seen.entity';
import { User } from '../users/entities/user.entity';
import { PlatformService } from './platform.service';
import { AnnouncementService } from './announcement.service';
import { PlatformAdminController } from './platform-admin.controller';
import { AnnouncementController } from './announcement.controller';
import { HelpSeenService } from './help-seen.service';
import { HelpSeenController } from './help-seen.controller';
import { LydiaContractService } from './lydia-contract.service';
import { LydiaFeeScheduleController } from './lydia-fee-schedule.controller';

/**
 * Platform-wide settings (maintenance mode, minimum client version), the admin announcement, and the
 * first-time helps an account has seen (the same "seen once per account" kind of state).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformConfig,
      PlatformAnnouncement,
      PlatformAnnouncementSeen,
      HelpSeen,
      User,
    ]),
  ],
  controllers: [
    PlatformAdminController,
    AnnouncementController,
    HelpSeenController,
    LydiaFeeScheduleController,
  ],
  providers: [PlatformService, AnnouncementService, HelpSeenService, LydiaContractService],
  exports: [PlatformService],
})
export class PlatformModule {}
