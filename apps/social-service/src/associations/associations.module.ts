import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Association } from './entities/association.entity';
import { AssociationMember } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import { AssociationsController } from './associations.controller';
import { AssociationRoleGuard } from './guards/association-role.guard';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { FollowsModule } from '../follows/follows.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 120_000, maxRedirects: 0 }),
    TypeOrmModule.forFeature([Association, AssociationMember]),
    FollowsModule,
  ],
  providers: [AssociationsService, AssociationRoleGuard, GlobalAdminOrAssociationRoleGuard],
  controllers: [AssociationsController],
  exports: [AssociationsService],
})
export class AssociationsModule {}
