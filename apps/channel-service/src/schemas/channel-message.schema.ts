import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type ChannelMessageDocument = HydratedDocument<ChannelMessage>;

@Schema({ collection: 'channel_messages' })
export class ChannelMessage {
  @Prop({ required: true })
  channelId: string;

  @Prop({ required: true })
  workspaceId: string;

  @Prop({ required: true })
  senderId: string;

  @Prop({ required: true })
  ciphertext: string;

  @Prop({ required: true })
  nonce: string;

  @Prop({ required: true })
  keyVersion: number;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ChannelMessageSchema = SchemaFactory.createForClass(ChannelMessage);
ChannelMessageSchema.index({ channelId: 1, createdAt: -1 });
