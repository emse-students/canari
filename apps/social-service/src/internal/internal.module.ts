import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalController } from './internal.controller';
import { Post } from '../posts/entities/post.entity';
import { ChannelMember } from '../channels/entities/channel-member.entity';
import { ChannelMessage } from '../channels/entities/channel-message.entity';
import { AssociationMember } from '../associations/entities/association-member.entity';
import { UserFollow } from '../follows/entities/user-follow.entity';
import { AssociationFollow } from '../follows/entities/association-follow.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserModeration } from '../moderation/entities/user-moderation.entity';
import { ContentReport } from '../moderation/entities/content-report.entity';

/** Exposes the internal account-deletion endpoint, not reachable via Nginx. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Post,
      ChannelMember,
      ChannelMessage,
      AssociationMember,
      UserFollow,
      AssociationFollow,
      UserTag,
      PurchaseRecord,
      UserModeration,
      ContentReport,
    ]),
  ],
  controllers: [InternalController],
})
export class InternalModule {}
