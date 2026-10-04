import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import type { SpaceCampus, SpaceFormation } from './space.entity';

/**
 * One rule of who an association (or list, or institution) addresses (D19). NULL means "any":
 * (ICM, saint-etienne) is one space, (null, saint-etienne) every formation on that campus - the ME
 * and the School's pole of Saint-Etienne - and (null, null) everyone. An association has one or more
 * rules and reaches the OPEN spaces they match, resolved at read time, so a space opened later is
 * reached with no edit here.
 */
@Entity('association_audiences')
export class AssociationAudience {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  associationId: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  formation: SpaceFormation | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  campus: SpaceCampus | null;
}
