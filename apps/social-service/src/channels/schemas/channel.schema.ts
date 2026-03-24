import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type ChannelDocument = HydratedDocument<Channel>;

@Schema({ collection: 'channels' })
export class Channel {
  @Prop({ required: true })
  workspaceId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ enum: ['public', 'private'], default: 'public' })
  visibility: 'public' | 'private';

  @Prop({ default: 1 })
  keyVersion: number;

  @Prop({ default: false })
  archived: boolean;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ChannelSchema = SchemaFactory.createForClass(Channel);
ChannelSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
