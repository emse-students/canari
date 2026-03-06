import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type KeyPackageDocument = HydratedDocument<KeyPackage>;

@Schema()
export class KeyPackage {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  deviceId: string;

  @Prop({ required: true })
  keyPackage: string; // Base64 encoded

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const KeyPackageSchema = SchemaFactory.createForClass(KeyPackage);
KeyPackageSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
KeyPackageSchema.index({ userId: 1, createdAt: -1 });
