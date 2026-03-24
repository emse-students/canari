import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Association } from './association.schema';

@Schema({ timestamps: true })
export class Event extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  basePriceCents: number;

  @Prop({ type: Types.ObjectId, ref: 'Association' })
  association: Association | Types.ObjectId;
}

export const EventSchema = SchemaFactory.createForClass(Event);
