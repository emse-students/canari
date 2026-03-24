import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

@Entity('channels')
@Index(['workspaceId', 'name'], { unique: true })
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workspaceId: string;

  @Column()
  name: string;

  @Column({ default: false })
  isPrivate: boolean;

  @Column('simple-array', { default: '' })
  allowedRoles: string[];

  @Column({ default: 1 })
  keyVersion: number;

  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
