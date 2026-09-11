import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserTag } from './entities/user-tag.entity';
import { LegacyCotisation } from './entities/legacy-cotisation.entity';
import { UserTagService } from './user-tag.service';
import { LegacyCotisationService } from './legacy-cotisation.service';
import { LegacyCotisationsAdminController } from './legacy-cotisations-admin.controller';

/** Provides UserTagService for managing association cotisation tags, and the legacy claim built on it. */
@Module({
  imports: [TypeOrmModule.forFeature([UserTag, LegacyCotisation])],
  controllers: [LegacyCotisationsAdminController],
  providers: [UserTagService, LegacyCotisationService],
  exports: [UserTagService, LegacyCotisationService],
})
export class UserTagModule {}
