// queued-message.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type QueuedMessageDocument = HydratedDocument<QueuedMessage>;

@Schema()
export class QueuedMessage {
  @Prop({ required: true })
  recipientId: string;

  @Prop({ required: true })
  deviceId: string;

  @Prop()
  proto?: string; // base64(InboundMsg) — set by gateway

  // Legacy fields (frontend fallback path)
  @Prop()
  senderId?: string;

  @Prop()
  senderDeviceId?: string;

  @Prop()
  groupId?: string;

  @Prop()
  type?: string;

  @Prop()
  content?: string;

  @Prop({ default: Date.now, expires: '7d' })
  createdAt: Date;
}

export const QueuedMessageSchema = SchemaFactory.createForClass(QueuedMessage);
QueuedMessageSchema.index({ recipientId: 1, deviceId: 1 });
