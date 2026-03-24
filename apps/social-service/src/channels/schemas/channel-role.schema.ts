import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { ChannelPermission } from '../permissions';

export type ChannelRoleDocument = HydratedDocument<ChannelRole>;

@Schema({ collection: 'channel_roles' })
export class ChannelRole {
  @Prop({ required: true })
  workspaceId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  priority: number;

  @Prop({ type: [String], default: [] })
  permissions: ChannelPermission[];

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ChannelRoleSchema = SchemaFactory.createForClass(ChannelRole);
ChannelRoleSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
