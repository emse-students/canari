import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type ChannelMemberDocument = HydratedDocument<ChannelMember>;

@Schema({ collection: 'channel_members' })
export class ChannelMember {
  @Prop({ required: true })
  channelId: string;

  @Prop({ required: true })
  workspaceId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  roleName: string;

  @Prop({ default: Date.now })
  joinedAt: Date;

  @Prop({ default: null })
  leftAt?: Date | null;
}

export const ChannelMemberSchema = SchemaFactory.createForClass(ChannelMember);
ChannelMemberSchema.index({ channelId: 1, userId: 1 }, { unique: true });
