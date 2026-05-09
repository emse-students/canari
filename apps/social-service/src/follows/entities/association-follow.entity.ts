import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('association_follows')
@Unique(['followerUserId', 'associationId'])
export class AssociationFollow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  followerUserId: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  @CreateDateColumn()
  createdAt: Date;
}
