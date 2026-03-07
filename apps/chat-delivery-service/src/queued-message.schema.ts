// queued-message.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type QueuedMessageDocument = HydratedDocument<QueuedMessage>;

@Schema()
export class QueuedMessage {
  @Prop({ required: true })
  recipientId: string; // The user who should receive this

  @Prop({ required: true })
  deviceId: string; // The specific device for fan-out

  @Prop({ required: true })
  senderId: string;

  @Prop()
  groupId: string; // Optional context

  @Prop()
  type: string;

  @Prop({ required: true })
  content: string; // Base64 content (MlsMessage)

  @Prop({ default: Date.now, expires: '7d' }) // Auto-delete after 7 days if unread
  createdAt: Date;
}

export const QueuedMessageSchema = SchemaFactory.createForClass(QueuedMessage);
QueuedMessageSchema.index({ recipientId: 1, deviceId: 1 });