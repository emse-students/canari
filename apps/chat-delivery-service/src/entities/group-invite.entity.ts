import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A shareable invite link for an MLS group chat. Accepting it does NOT perform any
 * crypto: it creates the invitee's `GroupMember` row + `pending` `DeviceGroupMembership`
 * rows, which the existing pending-invitation pipeline (any online member, add-lock,
 * addMember + Welcome) then fulfills.
 */
@Entity('group_invites')
export class GroupInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  groupId: string;

  /** Opaque random token embedded in the shareable URL. */
  @Column({ unique: true })
  @Index()
  token: string;

  @Column({ type: 'varchar', length: 255 })
  createdBy: string;

  /** Optional expiry; null = never expires. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Optional cap on accepted joins; null = unlimited. */
  @Column({ type: 'int', nullable: true })
  maxUses: number | null;

  @Column({ type: 'int', default: 0 })
  uses: number;

  @Column({ default: false })
  revoked: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
