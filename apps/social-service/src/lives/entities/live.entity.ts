import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { LiveEndReason } from '../live.constants';

/** One open live per broadcaster: the partial unique index's name, shared with migration 091. */
export const LIVES_ONE_OPEN_PER_BROADCASTER = 'lives_one_open_per_broadcaster';

/**
 * A live broadcast (WP-L2, docs/wiki/services/lives.md, migration 091).
 *
 * THE END IS THIS ROW'S STATE. `endedAt` is written once - by the broadcaster, by staff (`cut`, WP-L8), by the sweep when
 * the broadcaster's segments stopped (`dropped`), or by an
 * account erasure (`erased`) - and from then on every read answers 410, no segment is accepted, and
 * the sweep deletes the segments and then this row. There is no replay (L3).
 *
 * The live key is stored SEALED (`liveKeyCiphertext`, migration 110, `live-key-at-rest.ts`), so a
 * database copy alone opens neither the segments nor the chat.
 *
 * The live key is served to every member who may watch, as a post's CEK is (L2, Q4). It protects the
 * segments against the store, a cache and anybody without an account - NOT against a viewer the
 * broadcaster removed, who already read it: removal is enforced by the server refusing that account
 * the key, the manifest and the segment names (`live_removed_viewers`), and the key is not rotated.
 */
@Entity('lives')
@Index(LIVES_ONE_OPEN_PER_BROADCASTER, ['broadcasterId'], {
  unique: true,
  where: `"endedAt" IS NULL`,
})
@Index('lives_ended_idx', ['endedAt'], { where: `"endedAt" IS NOT NULL` })
@Check('lives_end_pair', `("endedAt" IS NULL) = ("endReason" IS NULL)`)
@Check(
  'lives_end_reason',
  `"endReason" IS NULL OR "endReason" IN ('broadcaster', 'dropped', 'max_duration', 'erased', 'cut')`
)
@Check('lives_key_one_form', `("liveKey" IS NULL) <> ("liveKeyCiphertext" IS NULL)`)
@Check('lives_key_version', `("liveKeyCiphertext" IS NULL) = ("liveKeyVersion" IS NULL)`)
@Index('lives_plaintext_key_idx', ['id'], { where: `"liveKey" IS NOT NULL` })
@Check('lives_next_index', `"nextIndex" >= 0`)
@Check('lives_stored_bytes', `"storedBytes" >= 0`)
@Check('lives_chat_seq', `"chatSeq" >= 0 AND "reactionSeq" >= 0`)
@Check(
  'lives_pending_whole',
  `("pendingName" IS NULL) = ("pendingSha256" IS NULL) AND ("pendingName" IS NULL) = ("pendingAt" IS NULL)`
)
export class Live {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The member broadcasting - a 64-char hex user id, never a uuid. `[deleted]` after an erasure. */
  @Column({ type: 'varchar', length: 255 })
  broadcasterId: string;

  /** The association the live is broadcast AS (`POST_AS_ASSO`), or NULL for the member's own. */
  @Column({ type: 'uuid', nullable: true })
  associationId: string | null;

  /**
   * THE PREVIOUS FORM of the key (migration 091): 64 hex characters in the clear. Written only by a
   * release before migration 110, and NULLed by the live sweep when it seals the row. Read through
   * `openLiveKey` alone (`live-key-at-rest.ts`); dropped once no row holds one.
   */
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  liveKey?: string | null;

  /**
   * The live key SEALED at rest (migration 110): AES-256-GCM under LIVE_KEY_ENCRYPTION_SECRET, bound
   * to this live's id and {@link liveKeyVersion}. Read and written by raw SQL only, through
   * `live-key-at-rest.ts`, so no entity serialisation ever carries it.
   */
  @Column({ type: 'text', nullable: true, select: false, insert: false, update: false })
  liveKeyCiphertext?: string | null;

  /** Which secret sealed {@link liveKeyCiphertext} - what a rotation of that secret reads. */
  @Column({ type: 'smallint', nullable: true, select: false, insert: false, update: false })
  liveKeyVersion?: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt: Date;

  /** Written by the segment ingest ONLY: the broadcaster's own liveness, which the sweep reads. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSegmentAt: Date | null;

  /** The index the next segment must carry; segments 0..nextIndex-1 are stored. */
  @Column({ type: 'integer', default: 0 })
  nextIndex: number;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  endReason: LiveEndReason | null;

  /** The sum of the stored segments' sizes, an OBSERVATION of what a live holds in the store, not a limit (no total budget since 2026-10-31). bigint: a string. */
  @Column({ type: 'bigint', default: 0 })
  storedBytes: string;

  /**
   * THE RESERVATION of index `nextIndex` by an ingest whose store is in flight: the name it stores
   * under, the bytes' digest and when it was taken (all three or none). Written in a committed step
   * BEFORE the store, so no database connection is held across the call to media-service; cleared
   * when the segment is counted or its store failed. The purge leaves the live alone while it is set.
   */
  @Column({ type: 'uuid', nullable: true })
  pendingName: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  pendingSha256: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  pendingAt: Date | null;

  /**
   * When the live's start was pushed to the broadcaster's followers (WP-L7, migration 094) - the
   * CLAIM, written before the send, so a live is announced at most once whoever asks (`LiveAnnouncer`).
   */
  @Column({ type: 'timestamptz', nullable: true })
  announcedAt: Date | null;

  /**
   * The last sequence number given to a chat message, or to a hide (WP-L6, migration 098). Taken
   * under this row's lock in the transaction that writes the message, so numbers commit in their
   * own order and a viewer's cursor never skips one (lives.md, C4).
   */
  @Column({ type: 'integer', default: 0 })
  chatSeq: number;

  /** The same for reaction bursts (C4, C7). */
  @Column({ type: 'integer', default: 0 })
  reactionSeq: number;
}
