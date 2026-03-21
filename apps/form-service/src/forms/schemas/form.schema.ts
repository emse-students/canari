import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FormDocument = HydratedDocument<Form>;

export interface FormOption {
  id: string;
  label: string;
  priceModifier: number; // in cents
}

export interface FormItem {
  id: string;
  label: string;
  required: boolean;
  type:
    | 'short_text'
    | 'long_text'
    | 'dropdown'
    | 'single_choice'
    | 'multiple_choice'
    | 'matrix_single'
    | 'matrix_multiple'
    | 'linear_scale';
  options?: FormOption[];
  rows?: string[];
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
}

@Schema({ timestamps: true, collection: 'forms' })
export class Form {
  @Prop({ required: true, index: true })
  ownerId: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({ default: 0 })
  basePrice: number; // cents

  @Prop({ default: 'eur' })
  currency: string;

  @Prop({ default: 'Submit' })
  submitLabel: string;

  @Prop({ type: Number })
  maxSubmissions?: number;

  @Prop({ default: false })
  requiresPayment: boolean;

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        label: { type: String, required: true },
        required: { type: Boolean, required: true },
        type: { type: String, required: true },
        options: [
          {
            id: { type: String, required: true },
            label: { type: String, required: true },
            priceModifier: { type: Number, default: 0 },
          },
        ],
        rows: [String],
        scale: {
          min: Number,
          max: Number,
          minLabel: String,
          maxLabel: String,
        },
      },
    ],
    default: [],
  })
  items: FormItem[];
}

export const FormSchema = SchemaFactory.createForClass(Form);
