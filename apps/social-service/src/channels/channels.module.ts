import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsController } from './channels.controller';
import { ChatReelMediaClient } from './chat-reel-media.client';
import { ChannelService } from './channel.service';
import { ChannelRetentionScheduler } from './channel-retention.scheduler';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { ChannelMessageFanout } from './entities/channel-message-fanout.entity';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { DistributionDeparture } from './entities/distribution-departure.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DistributionDeparture,
      Workspace,
      Channel,
      ChannelRole,
      ChannelMember,
      ChannelMessage,
      ChannelMessageFanout,
      WorkspaceInvite,
    ]),
    HttpModule,
  ],
  controllers: [ChannelsController],
  providers: [ChannelService, ChannelRetentionScheduler, ChatReelMediaClient],
  exports: [ChannelService],
})
export class ChannelsModule {}
