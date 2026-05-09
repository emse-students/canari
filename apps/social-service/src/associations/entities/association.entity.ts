import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('associations')
export class Association {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  @Index()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Public-facing markdown body (optional). */
  @Column({ type: 'text', nullable: true })
  bioMarkdown: string | null;

  @Column({ type: 'varchar', nullable: true })
  logoUrl: string | null;

  /** Media-service UUID for GET /api/media/public/:id (opaque blob in MinIO). */
  @Column({ type: 'uuid', nullable: true })
  logoMediaId: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeAccountId: string | null;

  @Column({ default: false })
  stripeOnboardingComplete: boolean;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
