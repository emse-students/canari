import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique, Index } from 'typeorm';

/**
 * Every MLS signature key a device has ever PUBLISHED, one row per key, never updated or deleted.
 *
 * Graine v2 (channel-encryption section 21) has a seed's minter endorse it with its device's MLS
 * signature key. A member reading a relayed seed verifies that endorsement against the minter's leaf
 * in the key group's tree - and once the minter's device has LEFT the tree, nothing on the client
 * still names that key. `key_package` cannot answer either: its one row per device is REPLACED on
 * every re-registration, so the key a seed was endorsed with a year ago is gone from it.
 *
 * So this is an append-only history, written from the KeyPackages a device uploads (the static one
 * and every one-time one), which is where the key is already public: any member can fetch a
 * device's KeyPackage and read the same bytes. The server records what the device published and
 * vouches for nothing more - the trust a BasicCredential already asks of it (section 7).
 */
@Entity()
@Unique('UQ_device_signature_key', ['userId', 'deviceId', 'signatureKey'])
export class DeviceSignatureKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  deviceId: string;

  /** The raw Ed25519 public key, base64 (32 bytes, 44 characters). */
  @Column({ type: 'varchar', length: 44 })
  signatureKey: string;

  /** When this server first saw the key - evidence of its age, never a validity bound. */
  @CreateDateColumn()
  firstSeenAt: Date;
}
