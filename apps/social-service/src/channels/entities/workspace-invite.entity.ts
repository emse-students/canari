import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** A shareable invite link that lets a user join a community (workspace). */
@Entity('workspace_invites')
export class WorkspaceInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  workspaceId: string;

  /** Opaque random token embedded in the shareable URL. */
  @Column({ unique: true })
  @Index()
  token: string;

  @Column({ type: 'varchar', length: 255 })
  createdBy: string;

  /** Optional expiry; null = never expires. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Optional cap on the number of accepted joins; null = unlimited. */
  @Column({ type: 'int', nullable: true })
  maxUses: number | null;

  @Column({ type: 'int', default: 0 })
  uses: number;

  @Column({ default: false })
  revoked: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
