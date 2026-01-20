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

  @Prop({ unique: true })
  uuid: string;

  @Prop({ type: [String], default: [] })
  readBy: string[];

  @Prop({ default: Date.now })
  createdAt: Date;
}


export const MessageSchema = SchemaFactory.createForClass(Message);
