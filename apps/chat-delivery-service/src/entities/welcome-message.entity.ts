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

  @Column()
  userId: string; // Recipient

  @Column()
  deviceId: string; // Recipient Device

  @Column({ nullable: true })
  senderUserId: string;

  @Column()
  groupId: string;

  @Column()
  message: string; // Base64 encoded Welcome message

  @Column({ nullable: true })
  ratchetTree?: string; // Base64 encoded RatchetTree

  @CreateDateColumn()
  createdAt: Date;
}
