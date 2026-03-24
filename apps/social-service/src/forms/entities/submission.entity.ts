import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('submissions')
@Index(['formId', 'userId'])
export class Submission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  formId: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  email: string;

  @Column('jsonb', { default: {} })
  answers: Record<string, any>;

  @Column({ default: 0 })
  totalPaid: number;

  @Column({ default: 'free' })
  paymentStatus: string;

  @Column({ nullable: true })
  stripeSessionId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
