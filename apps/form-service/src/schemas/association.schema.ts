import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Association extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: false })
  stripeAccountId?: string; // ID du compte Stripe Connect (Express)
}

export const AssociationSchema = SchemaFactory.createForClass(Association);