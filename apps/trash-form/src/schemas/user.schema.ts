import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class User extends Document {
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: false })
  stripeCustomerId?: string; // ID du Customer Stripe pour sauvegarder la carte
}

export const UserSchema = SchemaFactory.createForClass(User);
