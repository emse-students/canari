import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** Past or honorary role held by a user within an association (profile CV). */
@Entity('association_role_history')
export class AssociationRoleHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, name: 'user_id' })
  @Index()
  userId: string;

  @Column({ type: 'uuid', name: 'association_id' })
  @Index()
  associationId: string;

  /** Display label, e.g. "Président", "Trésorier". */
  @Column({ type: 'varchar', length: 120, name: 'role_title' })
  roleTitle: string;

  @Column({ type: 'int', nullable: true, name: 'start_year' })
  startYear: number | null;

  @Column({ type: 'int', nullable: true, name: 'end_year' })
  endYear: number | null;

  /** Lower values appear first in profile lists. */
  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
