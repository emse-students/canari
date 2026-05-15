import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a dynamic form, optionally linked to an association and Stripe payment. */
@Entity('forms')
export class Form {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  ownerId: string;

  @Column()
  title: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: 0 })
  basePrice: number;

  @Column({ default: 'eur' })
  currency: string;

  @Column({ default: 'Submit' })
  submitLabel: string;

  @Column({ nullable: true })
  maxSubmissions: number;

  /** When set, submissions are rejected until this instant (shotgun / scheduled opening). */
  @Column({ type: 'timestamptz', nullable: true })
  opensAt: Date | null;

  @Column({ default: false })
  requiresPayment: boolean;

  @Column('simple-array', { default: 'card' })
  paymentMethods: string[];

  @Column({ type: 'uuid', nullable: true })
  @Index()
  associationId: string;

  @Column('jsonb', { default: [] })
  items: any[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
