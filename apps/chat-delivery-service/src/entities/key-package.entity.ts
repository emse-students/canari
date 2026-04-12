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

  @Column({ type: 'varchar', length: 80, nullable: true })
  deviceName?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  deviceOs?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  deviceAppVersion?: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
