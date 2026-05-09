import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class WelcomeMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  userId: string; // Recipient

  @Column()
  deviceId: string; // Recipient Device

  @Column({ type: 'varchar', length: 255, nullable: true })
  senderUserId: string | null;

  @Column({ type: 'uuid' })
  groupId: string;

  @Column()
  message: string; // Base64 encoded Welcome message

  @Column({ nullable: true })
  ratchetTree?: string; // Base64 encoded RatchetTree

  @CreateDateColumn()
  createdAt: Date;
}
