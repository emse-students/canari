import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChannelsController } from './channels.controller';
import { ChannelService } from './channel.service';

import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { ChannelRole, ChannelRoleSchema } from './schemas/channel-role.schema';
import { Channel, ChannelSchema } from './schemas/channel.schema';
import { ChannelMember, ChannelMemberSchema } from './schemas/channel-member.schema';
import { ChannelMessage, ChannelMessageSchema } from './schemas/channel-message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: ChannelRole.name, schema: ChannelRoleSchema },
      { name: Channel.name, schema: ChannelSchema },
      { name: ChannelMember.name, schema: ChannelMemberSchema },
      { name: ChannelMessage.name, schema: ChannelMessageSchema },
    ]),
  ],
  controllers: [ChannelsController],
  providers: [ChannelService],
})
export class ChannelsModule {}
