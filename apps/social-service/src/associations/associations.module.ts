import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Association } from './entities/association.entity';
import { AssociationMember } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import { AssociationsController } from './associations.controller';
import { AssociationRoleGuard } from './guards/association-role.guard';
import { FollowsModule } from '../follows/follows.module';

@Module({
  imports: [TypeOrmModule.forFeature([Association, AssociationMember]), FollowsModule],
  providers: [AssociationsService, AssociationRoleGuard],
  controllers: [AssociationsController],
  exports: [AssociationsService],
})
export class AssociationsModule {}
