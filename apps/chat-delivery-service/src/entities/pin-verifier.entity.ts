import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique } from 'typeorm';

/**
 * Stores a cryptographic verifier derived from the user's local PIN or biometric
 * secret. The verifier is used during device sync to confirm that the new device
 * is being authorised by the legitimate account owner without transmitting the
 * raw PIN. There is at most one row per user; it is replaced on PIN change.
 */
@Entity()
@Unique(['userId'])
export class PinVerifier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User this PIN verifier belongs to. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Opaque cryptographic verifier (e.g. a hash or OPAQUE envelope) derived from the user's PIN. */
  @Column()
  verifier: string;

  /** Per-user random salt for PBKDF2-based PIN verifier derivation. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  salt: string | null;

  @CreateDateColumn()
  registeredAt: Date;
}
