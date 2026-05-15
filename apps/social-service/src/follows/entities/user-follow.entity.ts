import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

/** TypeORM entity recording that a user follows another user. */
@Entity('user_follows')
@Unique(['followerUserId', 'followedUserId'])
export class UserFollow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  followerUserId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  followedUserId: string;

  @CreateDateColumn()
  createdAt: Date;
}
