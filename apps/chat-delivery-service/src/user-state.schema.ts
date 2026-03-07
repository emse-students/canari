import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserStateDocument = HydratedDocument<UserState>;

@Schema()
export class UserState {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ required: true })
  encryptedState: string; // Base64 encoded encrypted state blob

  @Prop({ default: Date.now })
  updatedAt: Date;
}

export const UserStateSchema = SchemaFactory.createForClass(UserState);
