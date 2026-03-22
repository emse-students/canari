import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';

@Entity()
@Unique(['userId', 'deviceId'])
export class KeyPackage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  deviceId: string;

  @Column()
  keyPackage: string; // Base64 encoded

  @CreateDateColumn()
  createdAt: Date;
}
