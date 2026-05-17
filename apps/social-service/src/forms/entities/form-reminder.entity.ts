import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('form_reminders')
@Index(['formId', 'userId'], { unique: true })
export class FormReminder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  formId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  @Column({ type: 'timestamptz' })
  opensAt: Date;

  @Column({ default: false })
  notified5min: boolean;

  @Column({ default: false })
  notifiedOnOpen: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
