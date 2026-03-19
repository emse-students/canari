import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type PostDocument = HydratedDocument<Post>;

export interface LinkMeta {
  url: string;
}

export interface PostImage {
  mediaId: string;
  key: string;
  iv: string;
  mimeType: string;
  size: number;
  fileName?: string;
}

export interface PollOption {
  id: string;
  label: string;
  votes: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  endsAt?: Date;
  votesByUser: Record<string, string[]>;
}

export interface EventButton {
  id: string;
  label: string;
  eventId: string;
  requiresPayment: boolean;
  amountCents?: number;
  currency?: string;
  stripePriceId?: string;
  capacity?: number;
  registrants: string[];
}

@Schema({ collection: 'posts' })
export class Post {
  @Prop({ required: true })
  authorId: string;

  @Prop({ required: true })
  markdown: string;

  @Prop({ type: [String], default: [] })
  mentions: string[];

  @Prop({
    type: [{ url: { type: String, required: true } }],
    default: [],
  })
  links: LinkMeta[];

  @Prop({
    type: [
      {
        mediaId: { type: String, required: true },
        key: { type: String, required: true },
        iv: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        fileName: { type: String, required: false },
      },
    ],
    default: [],
  })
  images: PostImage[];

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        question: { type: String, required: true },
        options: [
          {
            id: { type: String, required: true },
            label: { type: String, required: true },
            votes: { type: Number, default: 0 },
          },
        ],
        multipleChoice: { type: Boolean, default: false },
        endsAt: { type: Date, required: false },
        votesByUser: { type: Object, default: {} },
      },
    ],
    default: [],
  })
  polls: Poll[];

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        label: { type: String, required: true },
        eventId: { type: String, required: true },
        requiresPayment: { type: Boolean, default: false },
        amountCents: { type: Number, required: false },
        currency: { type: String, required: false },
        stripePriceId: { type: String, required: false },
        capacity: { type: Number, required: false },
        registrants: { type: [String], default: [] },
      },
    ],
    default: [],
  })
  eventButtons: EventButton[];

  @Prop({ default: Date.now })
  createdAt: Date;

  @Prop({ default: Date.now })
  updatedAt: Date;
}

export const PostSchema = SchemaFactory.createForClass(Post);
PostSchema.index({ createdAt: -1 });
PostSchema.index({ authorId: 1, createdAt: -1 });
