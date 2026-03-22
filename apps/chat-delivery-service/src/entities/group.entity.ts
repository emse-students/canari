import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('dm_groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  name?: string;

  @Column({ default: false })
  isGroup: boolean;

  @Column({ default: 1 })
  keyVersion: number;

  @Column({ default: 0 })
  activeEpoch: number;

  @Column({ type: 'jsonb', nullable: true })
  latestKeyRotationPayload: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
