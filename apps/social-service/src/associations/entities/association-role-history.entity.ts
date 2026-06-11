import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** Past or honorary role held by a user within an association (profile CV). */
@Entity('association_role_history')
export class AssociationRoleHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  /** Display label, e.g. "Président", "Trésorier". */
  @Column({ type: 'varchar', length: 120 })
  roleTitle: string;

  @Column({ type: 'int', nullable: true })
  startYear: number | null;

  @Column({ type: 'int', nullable: true })
  endYear: number | null;

  /** Lower values appear first in profile lists. */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;
}
