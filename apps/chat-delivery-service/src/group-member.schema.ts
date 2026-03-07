import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GroupMemberDocument = HydratedDocument<GroupMember>;

@Schema()
export class GroupMember {
  @Prop({ required: true })
  groupId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  deviceId: string;

  @Prop({ default: Date.now })
  joinedAt: Date;
}

export const GroupMemberSchema = SchemaFactory.createForClass(GroupMember);
GroupMemberSchema.index(
  { groupId: 1, userId: 1, deviceId: 1 },
  { unique: true },
);
