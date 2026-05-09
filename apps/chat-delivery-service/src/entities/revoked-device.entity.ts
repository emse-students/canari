import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';

@Entity()
@Unique(['userId', 'deviceId'])
export class RevokedDevice {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  @Column()
  deviceId: string;

  @CreateDateColumn()
  revokedAt: Date;
}
