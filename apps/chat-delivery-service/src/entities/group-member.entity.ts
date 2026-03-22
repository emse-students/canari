import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity('dm_group_members')
@Unique(['groupId', 'userId'])
export class GroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  groupId: string;

  @Column()
  userId: string;

  @Column({ type: 'enum', enum: ['admin', 'member'], default: 'member' })
  role: 'admin' | 'member';

  @CreateDateColumn()
  joinedAt: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  leftAt?: Date | null;
}
