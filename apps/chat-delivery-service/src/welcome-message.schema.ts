import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WelcomeMessageDocument = HydratedDocument<WelcomeMessage>;

@Schema()
export class WelcomeMessage {
  @Prop({ required: true })
  userId: string; // Recipient

  @Prop({ required: true })
  deviceId: string; // Recipient Device

  @Prop()
  senderUserId: string; // The user who created the welcome (the inviter)

  @Prop({ required: true })
  groupId: string;

  @Prop({ required: true })
  message: string; // Base64 encoded Welcome message

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const WelcomeMessageSchema =
  SchemaFactory.createForClass(WelcomeMessage);
