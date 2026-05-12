import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** TypeORM entity representing a named role within a workspace, holding an ordered permission set. */
@Entity('channel_roles')
@Index(['workspaceId', 'name'], { unique: true })
export class ChannelRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column()
  name: string;

  @Column()
  priority: number;

  @Column('simple-array', { default: '' })
  permissions: string[];

  @CreateDateColumn()
  createdAt: Date;
}
