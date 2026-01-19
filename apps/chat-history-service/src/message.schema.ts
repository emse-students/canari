import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

@Schema()
export class Message {
  @Prop()
  content: string;

  @Prop()
  username: string;

  @Prop()
  senderId: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}


export const MessageSchema = SchemaFactory.createForClass(Message);
