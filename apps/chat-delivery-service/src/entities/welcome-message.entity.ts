import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

/**
 * Persists an MLS Welcome message that has been generated for a specific device but
 * not yet retrieved. When an existing group member adds a new device, the server
 * stores the Welcome here so the new device can fetch it (and the accompanying
 * RatchetTree) on its next connection without requiring the sender to be online.
 * Entries are deleted once the recipient device acknowledges receipt.
 */
@Entity()
export class WelcomeMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User ID of the device that should receive this Welcome. */
  @Column({ type: 'varchar', length: 255 })
  userId: string; // Recipient

  /** Device ID of the intended recipient. */
  @Column()
  deviceId: string; // Recipient Device

  /** User ID of the group member who sent the Welcome (i.e. performed the Add Commit). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  senderUserId: string | null;

  /** MLS group the recipient is being welcomed into. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** Base64-encoded serialised MLS Welcome message that allows the recipient to join the group. */
  @Column()
  message: string; // Base64 encoded Welcome message

  /** Base64-encoded serialised MLS RatchetTree; sent alongside the Welcome so the new member
   *  can verify the full group tree without an additional round-trip. */
  @Column({ nullable: true })
  ratchetTree?: string; // Base64 encoded RatchetTree

  @CreateDateColumn()
  createdAt: Date;
}
