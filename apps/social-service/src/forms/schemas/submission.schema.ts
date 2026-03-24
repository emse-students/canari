import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type SubmissionDocument = HydratedDocument<Submission>;

@Schema({ timestamps: true, collection: 'submissions' })
export class Submission {
  @Prop({ required: true, index: true })
  formId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop()
  email?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  answers: Record<string, any>; // itemId -> value

  @Prop({ default: 0 })
  totalPaid: number; // cents

  @Prop({ default: 'free' })
  paymentStatus: 'free' | 'pending' | 'paid' | 'failed';

  @Prop()
  stripeSessionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const SubmissionSchema = SchemaFactory.createForClass(Submission);
SubmissionSchema.index({ formId: 1, userId: 1 });
