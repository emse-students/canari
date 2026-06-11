import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalController } from './internal.controller';
import { InternalFormsController } from './internal-forms.controller';
import { InternalProductsController } from './internal-products.controller';
import { FormsModule } from '../forms/forms.module';
import { AssociationsModule } from '../associations/associations.module';
import { Post } from '../posts/entities/post.entity';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { ChannelMessage } from '../channels/entities/channel-message.entity';
import { AssociationMember } from '../associations/entities/association-member.entity';
import { AssociationRoleHistory } from '../associations/entities/association-role-history.entity';
import { UserFollow } from '../follows/entities/user-follow.entity';
import { AssociationFollow } from '../follows/entities/association-follow.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';

/** Exposes internal endpoints for account deletion and form payment callbacks. */
@Module({
  imports: [
    FormsModule,
    AssociationsModule,
    TypeOrmModule.forFeature([
      Post,
      ChannelMember,
      ChannelMessage,
      AssociationMember,
      AssociationRoleHistory,
      UserFollow,
      AssociationFollow,
      UserTag,
      PurchaseRecord,
      UserModeration,
      ContentReport,
    ]),
  ],
  controllers: [InternalController, InternalFormsController, InternalProductsController],
})
export class InternalModule {}
