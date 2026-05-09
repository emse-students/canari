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

  @Column()
  @Index()
  followerUserId: string;

  @Column()
  @Index()
  associationId: string;

  @CreateDateColumn()
  createdAt: Date;
}
