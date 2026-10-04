import { Entity, PrimaryColumn } from 'typeorm';

/** An association (or list) belongs to a space, and so does the content it publishes (D19). */
@Entity('association_spaces')
export class AssociationSpace {
  @PrimaryColumn({ type: 'uuid' })
  associationId: string;

  @PrimaryColumn({ type: 'uuid' })
  spaceId: string;
}
