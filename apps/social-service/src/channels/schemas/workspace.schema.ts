import { HydratedDocument } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export type WorkspaceDocument = HydratedDocument<Workspace>;

@Schema({ collection: 'channel_workspaces' })
export class Workspace {
  @Prop({ required: true, unique: true })
  slug: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  createdBy: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
