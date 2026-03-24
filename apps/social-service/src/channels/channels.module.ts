import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsController } from './channels.controller';
import { ChannelService } from './channel.service';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { Workspace } from './entities/workspace.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace, Channel, ChannelRole, ChannelMember, ChannelMessage]),
    HttpModule,
  ],
  controllers: [ChannelsController],
  providers: [ChannelService],
})
export class ChannelsModule {}
