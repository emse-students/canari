import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Association } from './entities/association.entity';
import { AssociationMember } from './entities/association-member.entity';
import { AssociationCalendarEvent } from './entities/association-calendar-event.entity';
import { AssociationDocument } from './entities/association-document.entity';
import { Post } from '../posts/entities/post.entity';
import { Form } from '../forms/entities/form.entity';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { AssociationsService } from './associations.service';
import { AssociationsController } from './associations.controller';
import { AssociationRoleGuard } from './guards/association-role.guard';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { FollowsModule } from '../follows/follows.module';
import { PushService } from '../push/push.service';
import { UserTagModule } from '../users/user-tag.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 120_000, maxRedirects: 0 }),
    TypeOrmModule.forFeature([
      Association,
      AssociationMember,
      AssociationCalendarEvent,
      AssociationDocument,
      Post,
      Form,
      PostNotification,
    ]),
    FollowsModule,
    UserTagModule,
  ],
  providers: [
    AssociationsService,
    AssociationRoleGuard,
    GlobalAdminOrAssociationRoleGuard,
    PushService,
  ],
  controllers: [AssociationsController],
  exports: [AssociationsService],
})
export class AssociationsModule {}
