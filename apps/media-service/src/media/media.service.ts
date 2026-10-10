import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { parseByteRange } from './byte-range';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';

/** UUID v4 pattern - used to validate user-supplied IDs before path joins and property accesses. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** How many finished legacy chunk sessions are remembered (uploadId -> mediaId) for an idempotent `complete`. */

const CHUNK_DIR = path.join(process.cwd(), 'chunks_temp');
// Stored in a dedicated directory so it can be mounted as a named Docker volume
// and survive container restarts / redeployments.
const MEDIA_DATA_DIR = path.join(process.cwd(), 'media_meta');
const MEDIA_META_FILE = path.join(MEDIA_DATA_DIR, 'media_metadata.json');
/**
 * Encrypted chat media blobs are purged after this idle period.
 *
 * Was 30 days until 2026-09-23. The August decision was "keep 30 days and make the clock honest
 * instead of moving it", because the window then measured *"since the last device that did not
 * already hold it fetched it"* rather than use - `POST /media/touch` closed that gap, so the
 * premise of keeping it short is spent. Measured on production before moving it: the bucket held
 * 66 MB against 73 GB free, and the sweep was taking ~1.5 objects/day, so +60 days costs ~150 MB.
 *
 * Only the `ephemeral` class ever reaches this clock - see {@link isSweepable}.
 */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * A reel SENT IN A CONVERSATION (`chat-reel`) is deleted this long after it was UPLOADED - not after
 * it was last read. `lastAccessAt` is refreshed by every download, so an idle clock would let a reel
 * watched every 29 days live for ever, the opposite of the promise the member was shown ("supprime
 * des serveurs apres 30 jours"). Overridable by env so a bench can cross it in seconds.
 * [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md)
 */
const CHAT_REEL_RETENTION_DAYS = 30;
const CHAT_REEL_RETENTION_MS = positiveIntEnv(
  'MEDIA_CHAT_REEL_RETENTION_MS',
  CHAT_REEL_RETENTION_DAYS * 24 * 60 * 60 * 1000
);
/**
 * What one member may upload as `chat-reel` per rolling 24 hours, so a single account cannot fill
 * the store (user, 2026-10-09: 500 MB). Counted from the metadata - `ownerId` is the only
 * attribution this service has - and refused with a 429, an ANSWER the client must not retry blindly.
 */
const CHAT_REEL_DAILY_BYTES = positiveIntEnv('MEDIA_CHAT_REEL_DAILY_BYTES', 500 * 1024 * 1024);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Purged metadata entries (tombstones) are removed from the index after this delay. */
const META_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;
/** Width of one bucket in the admin panel's growth breakdown. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A positive integer from the environment, or the default: an unset or garbled value is not a zero. */
function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Renders a window for a log line, so no message ever spells a duration next to its constant. */
function msToDays(ms: number): number {
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * What the media bucket holds, broken down so its size can be EXPLAINED rather than only reported.
 * See {@link MediaService.getStorageStats} for what each field distinguishes.
 */
export interface MediaStorageStats {
  totalBytes: number;
  objectCount: number;
  /** Bytes last written in each of the last four 7-day windows, index 0 being the most recent. */
  recentBytesByWeek: number[];
  /** Bytes last written before those four windows. */
  olderBytes: number;
  /** Objects whose store reported no modification date, so they are in no window above. */
  undatedCount: number;
  /** Live objects the retention sweep should already have removed. */
  overdueCount: number;
  overdueBytes: number;
  /** Age of the oldest overdue object. Under one sweep interval it is a schedule, over it a fault. */
  overdueOldestMs: number | null;
  /** Present in the bucket, absent from the metadata index - unreachable by the sweep for ever. */
  untrackedCount: number;
  untrackedBytes: number;
  /** Metadata says purged, object still present: a delete that failed. */
  tombstonedCount: number;
  tombstonedBytes: number;
  /** Logos and other plaintext branding, exempt from retention by design - never counted as overdue. */
  publicAssetCount: number;
  publicAssetBytes: number;
  /**
   * Feed objects (posts, post comments, avatars) held for ever. Reported separately because an
   * exempt class with no line of its own is a class whose growth nothing can ever see - the same
   * defect the bucket breakdown was split to fix on 2026-08-18.
   */
  archiveCount: number;
  archiveBytes: number;
  /** Association vault documents: kept for ever AND outliving their uploader's account. */
  associationCount: number;
  associationBytes: number;
  /**
   * CanaReels' videos, kept until their own post expires (30 days) and reaped by social-service
   * with the post. Reported on their own line for the reason `archive` is: an exempt class folded
   * into a total is one whose growth nothing can see, and here a count that does not fall back is
   * the signal that the reel worker has stopped.
   */
  reelCount: number;
  reelBytes: number;
  /**
   * Reels sent in conversations: swept by AGE (30 days from upload). Its own line, and an `overdue`
   * pair beside it, for the reason `reel` and `archive` have theirs: a count that does not fall back
   * is the signal that the sweep has stopped, and folded into a total nothing could see it.
   */
  chatReelCount: number;
  chatReelBytes: number;
  chatReelOverdueCount: number;
  chatReelOverdueBytes: number;
  /** The window the sweep applies to them, echoed so the reader need not know the constant. */
  chatReelRetentionMs: number;
  /**
   * Live objects carrying no class at all: everything stored before the sweep became an allowlist
   * (2026-10-01), and every upload from a client too old to name its surface. The sweep may not
   * touch them, so this line is where their growth shows.
   */
  unclassifiedCount: number;
  unclassifiedBytes: number;
  /** Echoed so the reader does not have to know the constants to interpret the numbers. */
  retentionMs: number;
  sweepIntervalMs: number;
}

/**
 * Why an object is gone. `reel_expired` (a `chat-reel` swept by age) and `reel_deleted` (its sender
 * took it back) are answered `410` like `retention_expired`: the member is told the video is gone,
 * not that it never existed ({@link isGoneTombstone}).
 */
type PurgeReason = 'retention_expired' | 'manual_delete' | 'reel_expired' | 'reel_deleted';

/** The tombstones a download answers `410` to. `manual_delete` keeps its older `404`. */
function isGoneTombstone(entry: { purgedAt?: number; purgeReason?: PurgeReason } | undefined) {
  return (
    !!entry?.purgedAt &&
    (entry.purgeReason === 'retention_expired' ||
      entry.purgeReason === 'reel_expired' ||
      entry.purgeReason === 'reel_deleted')
  );
}

/**
 * Which retention an object gets. The service holds ciphertext and cannot tell one surface's blob
 * from another's, so the class is set by whoever knows: the CLIENT at upload, social-service for a
 * row it owns.
 *
 * THE IDLE SWEEP IS AN ALLOWLIST: it deletes `ephemeral` and nothing else ({@link isSweepable}).
 * It used to be the opposite - every object was swept unless it was exempt - and that denylist is
 * what deleted an association's vault document on production (2026-09): the document upload named
 * no class, so it fell to the default, and the default was "delete". A class nobody thought of was
 * a class the sweep destroyed. Now a class nobody thought of, an upload from a client too old to
 * name one, and an entry re-created after an index loss are all KEPT, which costs storage; the
 * other way round cost a member's file.
 *
 * - `ephemeral` - chat and channel media. A conversation scrolls away, so an idle window is the
 *   right question to ask of it. The only class the sweep may take.
 * - `archive` - the feed: post media, post-comment media and avatars. A post is a permanent row
 *   whose body would rot under an idle window (on 2026-09-23, 22 of the feed's 44 media had already
 *   been swept while their posts remained). Still reached by account deletion: a post photo is its
 *   uploader's.
 * - `association` - an association's vault documents. Kept for ever AND skipped by account
 *   deletion, because the document belongs to the association, not to the officer who happened to
 *   upload it; only deleting the document row deletes it.
 * - `reel` - a CanaReel's video. Kept by the idle sweep (the post, not idleness, decides its end)
 *   and reaped by social-service's `ReelRetentionScheduler` through {@link MediaService.purgeReels}
 *   when the post expires, 30 days after publication. Still reached by account deletion: a reel is
 *   its uploader's.
 *
 * - `chat-reel` - a CanaReel sent in a conversation. The only class swept by AGE
 *   ({@link CHAT_REEL_RETENTION_MS} from upload, never from the last read), tombstoned `reel_expired`
 *   and answered `410`. SET BY THE CLIENT AT UPLOAD, which is safe where `association` is not: a
 *   client that labels something `chat-reel` gains only a SHORTER life, and pays the daily cap
 *   ({@link CHAT_REEL_DAILY_BYTES}). It cannot be applied to an existing id (`internal/retention-class`
 *   refuses it) - the class is attached at the moment its owner and size are known. Its sender may
 *   delete it ({@link MediaService.removeChatReel}), on the ownership allowlist.
 *
 * None of them is `publicAsset`: that flag also opens `GET /media/public/:id` (no JWT), so reusing
 * it would put ciphertext on an unauthenticated route.
 */
export type RetentionClass = 'ephemeral' | 'archive' | 'association' | 'reel' | 'chat-reel';

export const RETENTION_CLASSES: ReadonlySet<string> = new Set<RetentionClass>([
  'ephemeral',
  'archive',
  'association',
  'reel',
  'chat-reel',
]);

/** What `purgeReels` answers for one object - see {@link MediaService.purgeReels}. */
export type ReelPurgeOutcome = 'deleted' | 'absent' | 'refused' | 'failed';

/** Runtime guard for the class name arriving from a request body. */
export function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === 'string' && RETENTION_CLASSES.has(value);
}

interface MediaMetaEntry {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: PurgeReason;
  /** Plaintext object served at GET /api/media/public/:id without JWT; exempt from retention purge. */
  publicAsset?: boolean;
  /** What the object is kept for; absent means unclassified, which the sweep never takes. See {@link RetentionClass}. */
  retentionClass?: RetentionClass;
  contentType?: string;
  /**
   * User who uploaded the blob, from the JWT `sub` of the upload request.
   *
   * The service never sees the plaintext, so this is the ONLY thing that can attribute an object
   * to a person - and without it an account deletion cannot reach the account's own uploads.
   * Absent on everything stored before 2026-08-11: those objects stay unattributable and are
   * reachable only by the retention sweep.
   */
  ownerId?: string;
  /**
   * Ciphertext size in bytes, recorded for `chat-reel` uploads ONLY: the daily cap sums it per
   * owner, and nothing else in the index needs a size (the listing of the store has them).
   */
  size?: number;
}

interface MediaMetadataStore {
  items: Record<string, MediaMetaEntry>;
}

type DownloadResult =
  | { status: 'ok'; data: Buffer }
  | { status: 'not_found' }
  | { status: 'purged' };

/** A download that may have been asked for a part: see {@link MediaService.downloadRange}. */
export type RangedDownloadResult =
  | {
      status: 'ok';
      data: Buffer;
      /** The whole object's length - what `Content-Range` names after the slash. */
      size: number;
      /** The part served, inclusive; null when the whole object was. */
      range: { start: number; end: number } | null;
    }
  | { status: 'unsatisfiable'; size: number }
  | { status: 'not_found' }
  | { status: 'purged' };

type PublicDownloadResult =
  | { status: 'ok'; data: Buffer; contentType: string }
  | { status: 'not_found' };

/** A chunked upload that declared itself a `chat-reel` at init and so holds budget until it ends. */
interface ChunkSession {
  ownerId: string;
  /** The total the client declared; appends beyond it are refused. */
  declaredBytes: number;
  /** Gives the reserved bytes back; idempotent. */
  release: () => void;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  /** Null-prototype map of media UUID → meta; avoids prototype pollution when loading JSON. */
  private readonly meta: MediaMetadataStore = { items: Object.create(null) };
  /** Per-uploadId locks that serialize concurrent chunk writes to prevent TOCTOU races. */
  private readonly uploadLocks = new Map<string, Promise<void>>();
  /**
   * Bytes of `chat-reel` uploads that passed the budget check and are not yet in the index, per
   * owner. Lazily created (specs build the service without its constructor). See
   * {@link reserveChatReelBudget}.
   */
  private chatReelReservations?: Map<string, number>;
  /** Chunked sessions that hold a reservation, by uploadId. Lazily created, same reason. */
  private chunkSessions?: Map<string, ChunkSession>;
  /**
   * Who opened each LEGACY chunk session, by uploadId (every session, not only the ones holding a
   * reservation). It exists so a client can abandon its own session ({@link abortChunkedUpload}) and
   * nobody else can. In memory: after a restart the answer is "unknown", and the staged file is
   * left to the orphan sweeper. Lazily created, same reason as above. Retired with the legacy chunk
   * routes (media-streaming-upload WP-S6).
   */
  private chunkOwners?: Map<string, string>;
  private readonly sweepIntervalMs = Number.parseInt(
    process.env.MEDIA_RETENTION_SWEEP_MS ?? `${DEFAULT_SWEEP_MS}`,
    10
  );

  constructor(private readonly storage: StorageService) {
    fs.ensureDirSync(CHUNK_DIR);
    fs.ensureDirSync(MEDIA_DATA_DIR);
    this.loadMetadata();
    void this.purgeExpiredMedia();

    const sweepMs =
      Number.isFinite(this.sweepIntervalMs) && this.sweepIntervalMs > 0
        ? this.sweepIntervalMs
        : DEFAULT_SWEEP_MS;
    const timer = setInterval(() => {
      void this.purgeExpiredMedia();
    }, sweepMs);
    timer.unref();
  }

  async upload(
    encryptedBytes: Buffer,
    ownerId?: string,
    retentionClass?: RetentionClass
  ): Promise<string> {
    const release = this.reserveChatReelBudget(retentionClass, ownerId, encryptedBytes.length);
    const mediaId = uuidv4();
    try {
      await this.storage.put(mediaId, encryptedBytes, encryptedBytes.length);
      // Registered in the same synchronous run that releases the reservation (`finally`), so the
      // bytes are never invisible to a concurrent check: counted as reserved, then as an entry.
      this.setAccess(mediaId, Date.now(), ownerId, retentionClass, encryptedBytes.length);
    } finally {
      release();
    }
    await this.persistMetadata();
    return mediaId;
  }

  /** Store a small public image (association logos, etc.); not encrypted; no retention purge. */
  async uploadPublicAsset(data: Buffer, contentType: string): Promise<string> {
    const mediaId = uuidv4();
    await this.storage.put(mediaId, data, data.length);
    const now = Date.now();
    this.meta.items[mediaId] = {
      createdAt: now,
      lastAccessAt: now,
      publicAsset: true,
      contentType,
    };
    await this.persistMetadata();
    return mediaId;
  }

  async download(mediaId: string): Promise<DownloadResult> {
    // Validate mediaId is a UUID to prevent path traversal and prototype pollution.
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    await this.purgeExpiredMedia();

    const entry = this.meta.items[mediaId];
    if (isGoneTombstone(entry)) {
      return { status: 'purged' };
    }

    const stream = await this.storage.get(mediaId);
    if (!stream) {
      return { status: 'not_found' };
    }

    const data = await this.readStreamToBuffer(stream);
    this.setAccess(mediaId, Date.now());
    await this.persistMetadata();
    return { status: 'ok', data };
  }

  /**
   * {@link download}, or the part of it a `Range` header asks for (CanaReels R2: a segmented blob is
   * read one segment at a time, so a video plays while the rest is still here).
   *
   * Authorisation and the retention tombstone are exactly the whole download's - a part of a purged
   * object is as gone as the object. THE ACCESS CLOCK MOVES ONLY ON A PART THAT STARTS AT BYTE 0:
   * every reader opens a blob there (its header is there), so one opening is one access, as one
   * whole download always was - rather than one metadata write per megabyte of a video.
   *
   * @param mediaId     The object.
   * @param rangeHeader The request's `Range` header, if any.
   */
  async downloadRange(
    mediaId: string,
    rangeHeader: string | undefined
  ): Promise<RangedDownloadResult> {
    if (!rangeHeader) {
      const whole = await this.download(mediaId);
      return whole.status === 'ok'
        ? { status: 'ok', data: whole.data, size: whole.data.length, range: null }
        : whole;
    }
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    await this.purgeExpiredMedia();

    const entry = this.meta.items[mediaId];
    if (isGoneTombstone(entry)) {
      return { status: 'purged' };
    }

    const size = await this.storage.size(mediaId);
    if (size === null) return { status: 'not_found' };

    const requested = parseByteRange(rangeHeader, size);
    if (requested.kind === 'whole') {
      this.logger.debug(`media ${mediaId}: Range "${rangeHeader}" not served as a part - whole`);
      const whole = await this.download(mediaId);
      return whole.status === 'ok'
        ? { status: 'ok', data: whole.data, size: whole.data.length, range: null }
        : whole;
    }
    if (requested.kind === 'unsatisfiable') {
      this.logger.debug(`media ${mediaId}: Range "${rangeHeader}" unsatisfiable on ${size} bytes`);
      return { status: 'unsatisfiable', size };
    }

    const stream = await this.storage.getRange(
      mediaId,
      requested.start,
      requested.end - requested.start + 1
    );
    if (!stream) return { status: 'not_found' };
    const data = await this.readStreamToBuffer(stream);
    // The one outcome of a ranged read that said nothing: its two siblings above log, and this line
    // is what shows a reader walking a blob segment by segment, in order, from the server's side.
    this.logger.debug(
      `media ${mediaId}: bytes ${requested.start}-${requested.end}/${size} served as a part`
    );
    if (requested.start === 0) {
      this.setAccess(mediaId, Date.now());
      await this.persistMetadata();
    }
    return { status: 'ok', data, size, range: { start: requested.start, end: requested.end } };
  }

  async downloadPublic(mediaId: string): Promise<PublicDownloadResult> {
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    await this.purgeExpiredMedia();

    const entry = this.meta.items[mediaId];

    // Normal path: metadata present and valid.
    if (this.isPublicAssetEntry(entry) && entry.contentType) {
      if (entry.purgedAt) return { status: 'not_found' };
      const stream = await this.storage.get(mediaId);
      if (!stream) return { status: 'not_found' };
      return {
        status: 'ok',
        data: await this.readStreamToBuffer(stream),
        contentType: entry.contentType,
      };
    }

    // NO FALLBACK, AND THE ONE THAT WAS HERE PUBLISHED WHATEVER IT WAS ASKED FOR.
    //
    // It served any blob whose metadata was missing and then WROTE `publicAsset: true` for it -
    // so one request on a chat object's id turned a private object into a public one, permanently,
    // for everybody. The route it sits behind is unauthenticated by design (an `<img>` on a page a
    // signed-out visitor sees), so "whoever asked" is anybody who can name a UUID. What came out
    // was E2EE ciphertext whose key never left the client, which is why this was not a disclosure -
    // but the metadata write was real, and nothing would ever have undone it.
    //
    // Its premise was "metadata lost after a container restart". That is no longer true and has not
    // been since `media_meta` became a named volume, mounted in all three estates. So this is the
    // fallback rule exactly: reaching it means the primary path failed, and the fix belongs THERE -
    // in whatever lost the index - not in a branch that guesses `image/webp` and publishes on trust.
    // An asset that has genuinely lost its metadata now 404s, visibly, instead of taking every
    // ciphertext with it.
    if (!entry) {
      this.logger.warn(
        `media ${mediaId}: asked for as a public asset with NO metadata entry - refusing. ` +
          `If a real logo is missing, the metadata index is what broke; the volume is media_meta.`
      );
    }

    return { status: 'not_found' };
  }

  /**
   * Refreshes the retention clock for media the client served from its OWN cache.
   *
   * THE CLOCK WAS MEASURING SOMETHING IT COULD NOT SEE. `lastAccessAt` is refreshed by
   * {@link download}, so the sweep's predicate reads as "the window since anyone last looked
   * at this". It is not: the client caches the ciphertext locally and forever
   * (`canari-media-ciphertext-v1`), so once a device has an object it never asks for it again.
   * A photograph opened every day by everyone in a conversation therefore produced exactly the
   * same server-side trace as one nobody ever opened again - the first download - and both were
   * deleted on the same day. The clock was, in practice, "one window since the last device that did
   * not already have it fetched it", while claiming to be about use.
   *
   * This endpoint closes that gap: the client reports a cache hit, and the object is treated as
   * used. The two rules that keep it cheap live on the CLIENT (`utils/mediaTouch.ts`): at most one
   * report per object per calendar day, and reports batched into one request. The server does not
   * need to enforce them - the write is idempotent within a day at this granularity - but it does
   * bound the batch, because a body is attacker-controlled.
   *
   * Unknown and already-purged ids are skipped rather than rejected: a client legitimately holds
   * cached ciphertext for an object the sweep has since deleted, and reviving a tombstone here
   * would resurrect an entry the retention decision already closed.
   *
   * @returns how many entries were actually refreshed, so the caller can log a no-op distinctly.
   */
  async touch(mediaIds: string[]): Promise<number> {
    let refreshed = 0;
    const now = Date.now();

    for (const mediaId of mediaIds) {
      if (!UUID_REGEX.test(mediaId)) continue;
      const entry = this.meta.items[mediaId];
      if (!entry || entry.purgedAt) continue;
      this.setAccess(mediaId, now);
      refreshed += 1;
    }

    if (refreshed > 0) await this.persistMetadata();
    return refreshed;
  }

  /**
   * Sets the retention class of existing objects.
   *
   * Callers are all social-service, which owns the rows that cite an object. `'archive'` and
   * `'association'` classify media a post, comment or vault document references - on upload the
   * client says so itself, so this exists for the objects stored BEFORE the class did, for uploads
   * from clients too old to name one, and as the repair after a metadata index loss (the index is a
   * JSON file, and `download()` re-creates a lost entry with no class at all).
   *
   * `'ephemeral'` is the release when a post or comment is deleted: the object joins the idle
   * window and the sweep takes it {@link RETENTION_MS} later. That is deliberately not an immediate
   * delete - an edit that merely removes an image reaches here too, and a destructive answer to an
   * ambiguous event is the wrong one. There is no "clear": an unclassified object is one the sweep
   * may never take, so clearing would strand it rather than release it.
   *
   * Unknown and purged ids are skipped rather than rejected - the caller's list comes from rows
   * that may well cite an object swept before any of this existed, and reviving a tombstone would
   * resurrect an entry the retention decision already closed. Public assets are skipped too: they
   * are plaintext branding with their own lifetime, and a class must never make one sweepable.
   *
   * @returns how many entries actually changed, so a no-op backfill logs distinctly from a repair.
   */
  async setRetentionClass(mediaIds: string[], retentionClass: RetentionClass): Promise<number> {
    let changed = 0;

    for (const mediaId of mediaIds) {
      if (!UUID_REGEX.test(mediaId)) continue;
      const entry = this.meta.items[mediaId];
      if (!entry || entry.purgedAt) continue;
      if (this.isPublicAssetEntry(entry)) continue;
      if (entry.retentionClass === retentionClass) continue;

      entry.retentionClass = retentionClass;
      changed += 1;
    }

    if (changed > 0) await this.persistMetadata();
    return changed;
  }

  /**
   * Promotes objects uploaded through the authenticated route (group avatars and community images,
   * before they went through `upload/public`) to public assets, so `GET /media/public/:id` serves
   * them to the invite card, the link preview and the SEO head.
   *
   * THE ALLOWLIST IS THE CONTENT, NOT THE CALLER'S WORD: every blob is decoded as an image and only
   * JPEG, PNG and WebP are promoted, under the content type the decoder reports. Ciphertext does not
   * decode, so a wrong id in the list cannot publish a private object - the failure the removed
   * lazy fallback in {@link downloadPublic} had.
   *
   * @returns the ids promoted and the ids refused, so the caller can log what it could not repair.
   */
  async promoteToPublicAssets(
    mediaIds: string[]
  ): Promise<{ promoted: string[]; refused: string[] }> {
    const promoted: string[] = [];
    const refused: string[] = [];

    for (const mediaId of mediaIds) {
      if (!UUID_REGEX.test(mediaId)) {
        refused.push(mediaId);
        continue;
      }
      const entry = this.meta.items[mediaId];
      if (!entry || entry.purgedAt) {
        refused.push(mediaId);
        continue;
      }
      if (this.isPublicAssetEntry(entry)) continue;

      const stream = await this.storage.get(mediaId);
      if (!stream) {
        refused.push(mediaId);
        continue;
      }
      try {
        const { format } = await sharp(await this.readStreamToBuffer(stream)).metadata();
        if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
          throw new Error(`format ${format ?? 'unknown'} is not a public image format`);
        }
        entry.publicAsset = true;
        entry.contentType = `image/${format}`;
        promoted.push(mediaId);
      } catch (err) {
        this.logger.warn(`media ${mediaId}: not promoted to a public asset - ${String(err)}`);
        refused.push(mediaId);
      }
    }

    if (promoted.length > 0) await this.persistMetadata();
    return { promoted, refused };
  }

  /**
   * Claims objects for CanaReels: sets class `reel` on every one that is the named owner's.
   *
   * The claim is what makes the later purge safe. A reel's row names its blob by id, ids are not
   * secrets, and the purge is destructive - so a member who cites SOMEBODY ELSE'S blob in a reel
   * must get nothing: the entry records who uploaded it (the JWT `sub`), and only the uploader can
   * claim it. A public asset, a purged entry, an unknown id and an object stored before ownership
   * was recorded (no `ownerId`) are all refused, never claimed on trust.
   *
   * Idempotent: an entry already `reel` is claimed again as a no-op.
   *
   * @returns the ids claimed (including ones already classified `reel`) and the ids refused.
   */
  async claimReels(
    mediaIds: string[],
    ownerId: string
  ): Promise<{ claimed: string[]; refused: string[] }> {
    const claimed: string[] = [];
    const refused: string[] = [];
    let changed = false;

    for (const mediaId of new Set(mediaIds)) {
      const entry = UUID_REGEX.test(mediaId) ? this.meta.items[mediaId] : undefined;
      if (
        !entry ||
        entry.purgedAt ||
        this.isPublicAssetEntry(entry) ||
        !entry.ownerId ||
        entry.ownerId !== ownerId
      ) {
        refused.push(mediaId);
        continue;
      }
      if (entry.retentionClass !== 'reel') {
        entry.retentionClass = 'reel';
        changed = true;
      }
      claimed.push(mediaId);
    }

    if (changed) await this.persistMetadata();
    if (refused.length > 0) {
      this.logger.warn(
        `Reel claim by ${ownerId}: ${refused.length} object(s) refused (unknown, purged, public or not theirs)`
      );
    }
    return { claimed, refused };
  }

  /**
   * Deletes the blobs of expired (or deleted) CanaReels, each on its OWNER's say-so.
   *
   * THE ALLOWLIST IS OWNERSHIP: an object is deleted only when its entry's `ownerId` equals the
   * `ownerId` the caller names, and it is neither a public asset nor an `association` document. A
   * comment's media on a reel is deleted too - under the commenter's id, which is how the worker
   * names it - so a blob a member merely cited cannot be taken by citing it. Not "class is
   * `reel`": a comment's media carries another class and must be reachable.
   *
   * One outcome per id, because the caller decides what a reel's row does next:
   * - `deleted` - removed now (and tombstoned `manual_delete`);
   * - `absent` - no entry, or already purged. SUCCESS: the object is gone as far as this service can
   *   tell, and a retry after a crash lands here - the idempotence the worker relies on;
   * - `refused` - an entry exists and is not the named owner's (or is protected). Terminal and
   *   logged: it is a forged reference, and leaving the object is the point;
   * - `failed` - the store refused or threw. The ONLY outcome that should keep a reel's row.
   *
   * Per id, a `try`: one object the store will not delete never blocks the rest.
   */
  async purgeReels(
    items: Array<{ mediaId: string; ownerId: string }>
  ): Promise<Record<string, ReelPurgeOutcome>> {
    // A Map, not an object: `mediaId` is caller-supplied and may be refused precisely because it is
    // not a UUID, so it must never be a property name.
    const results = new Map<string, ReelPurgeOutcome>();
    let changed = false;

    for (const { mediaId, ownerId } of items) {
      if (!UUID_REGEX.test(mediaId)) {
        results.set(mediaId, 'refused');
        continue;
      }
      const entry = this.meta.items[mediaId];
      if (!entry || entry.purgedAt) {
        results.set(mediaId, 'absent');
        continue;
      }
      if (
        !ownerId ||
        entry.ownerId !== ownerId ||
        this.isPublicAssetEntry(entry) ||
        entry.retentionClass === 'association'
      ) {
        results.set(mediaId, 'refused');
        this.logger.warn(
          `Reel purge refused for ${mediaId}: not owned by ${ownerId || '(none)'}, or protected`
        );
        continue;
      }
      try {
        await this.storage.delete(mediaId);
      } catch (err) {
        results.set(mediaId, 'failed');
        this.logger.warn(
          `Reel purge could not delete ${mediaId}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      this.meta.items[mediaId] = {
        createdAt: entry.createdAt,
        lastAccessAt: entry.lastAccessAt,
        purgedAt: Date.now(),
        purgeReason: 'manual_delete',
      };
      changed = true;
      results.set(mediaId, 'deleted');
    }

    if (changed) await this.persistMetadata();
    return Object.fromEntries(results);
  }

  /**
   * The SENDER takes back a reel they sent in a conversation (delete for everyone).
   *
   * Allowed here and refused for ordinary media ({@link remove} is service-to-service) because a reel
   * message cannot be forwarded: the reason ordinary chat media is never deleted on a message's
   * deletion - one blob cited from conversations the deleter cannot see - does not apply. THE
   * ALLOWLIST IS TWO FACTS, both required: the object's class is `chat-reel` AND its `ownerId` is the
   * caller. Anything else is `refused`, so this route cannot be aimed at a feed photo, a vault
   * document or somebody else's reel.
   *
   * - `deleted` - removed now and tombstoned `reel_deleted` (the next read answers `410`);
   * - `absent` - no entry, or already purged: SUCCESS, so a retry after a crash lands here;
   * - `refused` - an entry exists and is not the caller's chat-reel;
   * - `failed` - the store refused or threw; the entry is kept so the delete can be retried.
   */
  async removeChatReel(
    mediaId: string,
    ownerId: string
  ): Promise<'deleted' | 'absent' | 'refused' | 'failed'> {
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    const entry = this.meta.items[mediaId];
    if (!entry || entry.purgedAt) return 'absent';
    if (!ownerId || entry.ownerId !== ownerId || entry.retentionClass !== 'chat-reel') {
      this.logger.warn(
        `Chat-reel delete refused for ${mediaId}: not a chat-reel owned by ${ownerId || '(none)'}`
      );
      return 'refused';
    }
    try {
      await this.storage.delete(mediaId);
    } catch (err) {
      this.logger.warn(
        `Chat-reel delete could not remove ${mediaId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return 'failed';
    }
    this.meta.items[mediaId] = {
      createdAt: entry.createdAt,
      lastAccessAt: entry.lastAccessAt,
      purgedAt: Date.now(),
      purgeReason: 'reel_deleted',
    };
    await this.persistMetadata();
    this.logger.log(`Chat-reel ${mediaId} deleted by its sender`);
    return 'deleted';
  }

  /**
   * Refuses (429) an upload that would take a member past the daily `chat-reel` budget, and RESERVES
   * the bytes in the same synchronous run, returning the function that gives them back.
   *
   * WHY A RESERVATION. The check used to be followed by an `await` (the store write) before the
   * entry was registered, so N concurrent uploads all read the same `used` and all passed: the cap
   * was per-request, not per-member. Here the check and the reservation share one tick, and the sum
   * counts live entries of the last 24 hours PLUS what is reserved and not yet registered. The
   * caller releases in a `finally`, in the same run that registers the entry, so a failed store write
   * rolls the reservation back and a successful one is never counted twice or not at all.
   *
   * Only a `chat-reel` is metered; any other class returns a no-op. A `chat-reel` with NO owner is an
   * error, not a free pass: the controller always has one (the JWT), so its absence is a caller bug
   * that would otherwise bypass the cap silently.
   */
  private reserveChatReelBudget(
    retentionClass: RetentionClass | undefined,
    ownerId: string | undefined,
    incomingBytes: number,
    restore = false
  ): () => void {
    if (retentionClass !== 'chat-reel') return () => {};
    if (!ownerId) {
      this.logger.error(
        'Chat-reel upload without an owner: the daily budget cannot be applied, refusing'
      );
      throw new InternalServerErrorException('A chat-reel upload needs an authenticated owner');
    }
    const reservations = (this.chatReelReservations ??= new Map<string, number>());
    const since = Date.now() - DAY_MS;
    let used = reservations.get(ownerId) ?? 0;
    for (const entry of Object.values(this.meta.items)) {
      if (entry.purgedAt || entry.retentionClass !== 'chat-reel' || entry.ownerId !== ownerId) {
        continue;
      }
      if (entry.createdAt >= since) used += entry.size ?? 0;
    }
    // `restore`: a reservation granted before a restart is being put back, not requested - it was
    // already within the cap when granted, and refusing it now would strand a session the member
    // was told they had.
    if (!restore && used + incomingBytes > CHAT_REEL_DAILY_BYTES) {
      this.logger.warn(
        `Chat-reel upload refused for ${ownerId}: ${used} bytes already today or in flight, ${incomingBytes} more over the ${CHAT_REEL_DAILY_BYTES} cap`
      );
      throw new HttpException(
        'Daily chat-reel upload budget reached. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    reservations.set(ownerId, (reservations.get(ownerId) ?? 0) + incomingBytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (reservations.get(ownerId) ?? 0) - incomingBytes;
      if (left > 0) reservations.set(ownerId, left);
      else reservations.delete(ownerId);
    };
  }

  /**
   * The daily `chat-reel` budget for the session routes, which reserve ONCE at init and release at
   * complete, cancel or expiry. Same machinery as {@link upload}; see {@link reserveChatReelBudget}.
   * `restore` puts back a reservation granted before a restart without re-judging it.
   */
  reserveUploadBudget(
    retentionClass: RetentionClass | undefined,
    ownerId: string,
    bytes: number,
    restore = false
  ): () => void {
    return this.reserveChatReelBudget(retentionClass, ownerId, bytes, restore);
  }

  /**
   * Registers an object a session upload has already stored. `onRegistered` runs in the SAME
   * synchronous run as the index entry, so the reservation hands over to it with no tick in which the
   * bytes count for neither (the invariant {@link reserveChatReelBudget} documents).
   */
  async registerUpload(
    mediaId: string,
    ownerId: string,
    retentionClass: RetentionClass | undefined,
    size: number,
    onRegistered: () => void
  ): Promise<void> {
    this.setAccess(mediaId, Date.now(), ownerId, retentionClass, size);
    onRegistered();
    await this.persistMetadata();
  }

  async remove(mediaId: string): Promise<void> {
    // Validate mediaId is a UUID to prevent prototype pollution via property key injection.
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    await this.storage.delete(mediaId);
    const now = Date.now();
    const current = this.meta.items[mediaId];
    // AN EXISTING TOMBSTONE KEEPS ITS OWN DATE AND REASON. Deleting the row that cites an object
    // the sweep already took is exactly what a member does after meeting the loss, and rewriting
    // the tombstone to `manual_delete` erased the only record that the sweep had been the cause -
    // which is how the vault document lost on production in 2026-09 first read as a deletion.
    if (current?.purgedAt) {
      this.logger.log(
        `media ${mediaId}: delete asked of an object already purged (${current.purgeReason ?? 'unknown'}) - tombstone kept`
      );
      return;
    }
    this.meta.items[mediaId] = {
      createdAt: current?.createdAt ?? now,
      lastAccessAt: current?.lastAccessAt ?? now,
      purgedAt: now,
      purgeReason: 'manual_delete',
    };
    await this.persistMetadata();
  }

  /**
   * Deletes every blob uploaded by a user. Called when the account itself is deleted.
   *
   * Only the UPLOADER's own objects: a message the user merely received belongs to whoever sent
   * it. Public assets and `association` documents are excluded - an association's logo and its
   * vault outlive the officer who uploaded them, and removing them would take them from everyone
   * else ({@link survivesAccountDeletion}).
   *
   * Deliberately NOT wired to message deletion: forwarding copies the reference, so one blob can
   * be cited by messages in conversations the deleter cannot see, and the server - holding only
   * ciphertext - can count no references. A deleted message's blob is left to the retention sweep.
   *
   * @param ownerId  User whose uploads are removed.
   * @returns Counts for the caller's log: what was deleted, and what could not be.
   */
  async removeAllOwnedBy(ownerId: string): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    for (const [mediaId, entry] of Object.entries(this.meta.items)) {
      if (entry.ownerId !== ownerId) continue;
      if (entry.purgedAt) continue;
      // `survivesAccountDeletion`, NOT "is not sweepable": a logo or a vault document outlives
      // the member who uploaded it, but an archived post photo is still that member's and must go
      // with the account. Exemption from the idle sweep is not exemption from erasure, and
      // conflating the two here would have made account deletion silently stop reaching the feed.
      if (this.survivesAccountDeletion(entry)) continue;

      try {
        await this.storage.delete(mediaId);
        deleted += 1;
      } catch (err) {
        // Same stranding risk as the retention sweep: say so rather than losing the object.
        failed += 1;
        this.logger.warn(
          `Account deletion could not remove ${mediaId} (object may be stranded): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      this.meta.items[mediaId] = {
        createdAt: entry.createdAt,
        lastAccessAt: entry.lastAccessAt,
        purgedAt: Date.now(),
        purgeReason: 'manual_delete',
      };
    }

    if (deleted > 0 || failed > 0) await this.persistMetadata();
    this.logger.log(`Account deletion for ${ownerId}: ${deleted} media deleted, ${failed} failed`);
    return { deleted, failed };
  }

  /**
   * What the bucket holds, and why it is that size.
   *
   * A total answers "how much" and nothing else, so a bucket that grows looks identical whether
   * people are uploading more or the retention has stopped removing anything - two causes with
   * opposite fixes. Every field below exists to separate them, and each is derived from the object
   * listing crossed with the metadata index, so the panel adds no stored state and no timer of its
   * own: ask it twice a month apart and the weekly buckets ARE the slope.
   *
   * The four causes it can tell apart:
   *  - `recentBytesByWeek` climbing, everything else flat: people are uploading more.
   *  - `overdue*` above zero with `overdueOldestMs` past a sweep interval: the retention sweep is
   *    not doing its job. Below one interval it is simply the window between expiry and the sweep.
   *  - `untracked*`: objects with no metadata entry at all. The sweep only ever iterates the
   *    metadata, so these can never be seen again by it - measured at 7 objects on 2026-08-11.
   *  - `tombstoned*`: the metadata says purged and the object is still there, so a delete failed.
   *    They become `untracked` once the tombstone is trimmed at 90 days.
   */
  async getStorageStats(): Promise<MediaStorageStats> {
    const objects = await this.storage.listObjects();
    const now = Date.now();
    const retentionCutoff = now - RETENTION_MS;

    const stats: MediaStorageStats = {
      totalBytes: 0,
      objectCount: objects.length,
      recentBytesByWeek: [0, 0, 0, 0],
      olderBytes: 0,
      undatedCount: 0,
      overdueCount: 0,
      overdueBytes: 0,
      overdueOldestMs: null,
      untrackedCount: 0,
      untrackedBytes: 0,
      tombstonedCount: 0,
      tombstonedBytes: 0,
      publicAssetCount: 0,
      publicAssetBytes: 0,
      archiveCount: 0,
      archiveBytes: 0,
      associationCount: 0,
      associationBytes: 0,
      reelCount: 0,
      reelBytes: 0,
      chatReelCount: 0,
      chatReelBytes: 0,
      chatReelOverdueCount: 0,
      chatReelOverdueBytes: 0,
      chatReelRetentionMs: CHAT_REEL_RETENTION_MS,
      unclassifiedCount: 0,
      unclassifiedBytes: 0,
      retentionMs: RETENTION_MS,
      sweepIntervalMs: this.sweepIntervalMs,
    };

    for (const object of objects) {
      stats.totalBytes += object.size;

      if (object.lastModifiedMs === null) {
        stats.undatedCount += 1;
      } else {
        const week = Math.floor((now - object.lastModifiedMs) / WEEK_MS);
        if (week >= 0 && week < stats.recentBytesByWeek.length) {
          stats.recentBytesByWeek[week] += object.size;
        } else {
          stats.olderBytes += object.size;
        }
      }

      const entry = this.meta.items[object.id];
      if (!entry) {
        stats.untrackedCount += 1;
        stats.untrackedBytes += object.size;
        continue;
      }
      if (entry.purgedAt) {
        stats.tombstonedCount += 1;
        stats.tombstonedBytes += object.size;
        continue;
      }
      if (this.isPublicAssetEntry(entry)) {
        stats.publicAssetCount += 1;
        stats.publicAssetBytes += object.size;
        continue;
      }
      if (entry.retentionClass === 'archive') {
        stats.archiveCount += 1;
        stats.archiveBytes += object.size;
        continue;
      }
      if (entry.retentionClass === 'association') {
        stats.associationCount += 1;
        stats.associationBytes += object.size;
        continue;
      }
      if (entry.retentionClass === 'reel') {
        stats.reelCount += 1;
        stats.reelBytes += object.size;
        continue;
      }
      if (entry.retentionClass === 'chat-reel') {
        stats.chatReelCount += 1;
        stats.chatReelBytes += object.size;
        // The SAME due-ness the sweep applies (`isDue`), so this is a verdict on the sweep.
        if (this.isDue(entry, now)) {
          stats.chatReelOverdueCount += 1;
          stats.chatReelOverdueBytes += object.size;
        }
        continue;
      }
      // Deliberately the SAME predicate purgeExpiredMedia uses. Anything counted as overdue is
      // something the sweep was supposed to have taken, so the number is a verdict on the sweep,
      // not an estimate of it - which is only true while the two predicates stay identical.
      if (!this.isSweepable(entry)) {
        stats.unclassifiedCount += 1;
        stats.unclassifiedBytes += object.size;
        continue;
      }
      if (entry.lastAccessAt < retentionCutoff) {
        stats.overdueCount += 1;
        stats.overdueBytes += object.size;
        const age = now - entry.lastAccessAt;
        if (stats.overdueOldestMs === null || age > stats.overdueOldestMs) {
          stats.overdueOldestMs = age;
        }
      }
    }

    return stats;
  }

  // --- Chunked upload ---

  /**
   * Opens a staged upload. A `chat-reel` MUST declare its `totalBytes` here: the daily budget is
   * checked and reserved NOW, so a member over budget is refused before staging anything, and the
   * staged file cannot grow past what was reserved. (The budget used to be checked only at assembly,
   * after up to 100 MB had already been staged.) A session that declares nothing keeps the older
   * behaviour and, if it then names `chat-reel` at completion, is checked there.
   */
  async initChunkedUpload(
    ownerId?: string,
    retentionClass?: RetentionClass,
    totalBytes?: number,
    maxBytes?: number
  ): Promise<string> {
    const uploadId = uuidv4();
    if (retentionClass === 'chat-reel') {
      if (!Number.isInteger(totalBytes) || (totalBytes as number) <= 0) {
        throw new BadRequestException("A 'chat-reel' chunked upload declares totalBytes at init");
      }
      if (maxBytes !== undefined && (totalBytes as number) > maxBytes) {
        throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
      }
      const release = this.reserveChatReelBudget(retentionClass, ownerId, totalBytes as number);
      (this.chunkSessions ??= new Map()).set(uploadId, {
        ownerId: ownerId as string,
        declaredBytes: totalBytes as number,
        release,
      });
    }
    try {
      await fs.ensureFile(this.chunkTempPath(uploadId));
    } catch (err) {
      this.dropChunkSession(uploadId);
      throw err;
    }
    // THE OPENER IS RECORDED ONLY ONCE THE STAGING EXISTS: an init refused earlier (a budget, a
    // size, a disk error) never registers an entry, so the sweeper - which forgets an opener whose
    // file is absent - can neither race the registration nor be left a stray one.
    if (ownerId) (this.chunkOwners ??= new Map()).set(uploadId, ownerId);
    return uploadId;
  }

  /**
   * Abandons a staged legacy upload: removes its temp file and gives back its reservation. Called by
   * a client that cancelled, was refused, or gave up on this session and is about to start a new one
   * - without it every such attempt strands up to the whole file on disk until the 24 h sweep.
   *
   * IDEMPOTENT: a session that is already gone (completed, swept, never existed, restarted away) is a
   * success, so a retried or doubled call never errors. OWNER-CHECKED: when the opener is known and
   * is somebody else, `ForbiddenException`; an unknown opener (the process restarted) is allowed,
   * since the uploadId is an unguessable UUID that only its opener was given.
   */
  async abortChunkedUpload(uploadId: string, ownerId?: string): Promise<'removed' | 'absent'> {
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    return this.withUploadLock(uploadId, async () => {
      const opener = this.chunkOwners?.get(uploadId);
      if (opener && opener !== ownerId) {
        this.logger.warn(`Chunked upload ${uploadId} abort refused: not its opener`);
        throw new ForbiddenException('Not your upload session');
      }
      const tempFile = this.chunkTempPath(uploadId);
      const existed = await fs.pathExists(tempFile);
      if (existed) await fs.remove(tempFile);
      this.dropChunkSession(uploadId);
      this.chunkOwners?.delete(uploadId);
      this.logger.log(
        `Chunked upload ${uploadId} abandoned by its client (${existed ? 'staged bytes removed' : 'nothing staged'})`
      );
      return existed ? 'removed' : 'absent';
    });
  }

  /** Gives a session's reservation back and forgets it; a no-op for a session that held none. */
  private dropChunkSession(uploadId: string): void {
    const session = this.chunkSessions?.get(uploadId);
    if (!session) return;
    session.release();
    this.chunkSessions?.delete(uploadId);
  }

  /**
   * Appends one chunk to a staged session. OWNER-CHECKED like abort and complete: when the opener
   * is known and is somebody else, `ForbiddenException` and nothing is written (an unknown opener,
   * after a restart, is allowed - the uploadId is an unguessable UUID only its opener was given).
   */
  async appendChunk(
    uploadId: string,
    chunk: Buffer,
    maxBytes: number,
    ownerId: string | undefined
  ): Promise<void> {
    // Validate uploadId is a UUID to prevent path traversal (uncontrolled data in path).
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    // Serialize concurrent chunk writes for the same uploadId to prevent TOCTOU race conditions.
    await this.withUploadLock(uploadId, async () => {
      const opener = this.chunkOwners?.get(uploadId) ?? this.chunkSessions?.get(uploadId)?.ownerId;
      if (opener && opener !== ownerId) {
        this.logger.warn(`Chunked upload ${uploadId} append refused: not its opener`);
        throw new ForbiddenException('Not your upload session');
      }
      const tempFile = this.chunkTempPath(uploadId);

      // ONE DESCRIPTOR, OPENED ONCE, AND THAT IS WHAT REMOVES THE RACE RATHER THAN HIDING IT.
      //
      // This was `pathExists` then `stat` then `appendFile`: three trips to the same PATH, each
      // one able to find something different from the last. Collapsing it to `stat` then
      // `appendFile` was an improvement and still a check followed by an act - correctly reported
      // as such - because a size measured through a path says nothing about the file the next
      // path lookup finds. The lock above serialises this process's own writers for one uploadId;
      // it says nothing about the sweeper that removes expired sessions.
      //
      // `r+` FAILS IF THE FILE IS ABSENT, which is exactly the "session not found" answer this
      // needs - `a` would create one and turn an expired upload into a new one. Everything after
      // it - the size, the write - happens on that one open handle, so there is no second lookup
      // to disagree with the first, and the write goes to the offset the size was read at rather
      // than to wherever the end happens to be by then.
      // `fs.promises.open`, NOT `fs.open`: fs-extra's promisified `open` resolves to a numeric
      // descriptor, which has no methods and would need the same path-free operations spelt as
      // free functions. The promises API hands back a handle that carries them.
      const handle = await fs.promises.open(tempFile, 'r+').catch(() => {
        throw new NotFoundException('Upload session not found or expired');
      });

      let overCap = false;
      try {
        const { size } = await handle.stat();
        // A session that declared its total may not stage more than it reserved.
        const cap = Math.min(
          maxBytes,
          this.chunkSessions?.get(uploadId)?.declaredBytes ?? maxBytes
        );
        overCap = size + chunk.length > cap;
        if (!overCap) await handle.write(chunk, 0, chunk.length, size);
      } finally {
        await handle.close();
      }

      // AFTER THE HANDLE IS CLOSED, and the partial upload still goes: a session that can never
      // complete is not worth the volume it occupies until the sweeper notices. Removing it while
      // the descriptor was open is what a Windows runner refuses, so the decision is taken inside
      // and acted on outside.
      if (overCap) {
        await fs.remove(tempFile);
        this.dropChunkSession(uploadId);
        this.chunkOwners?.delete(uploadId);
        throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
      }
    });
  }

  async completeChunkedUpload(
    uploadId: string,
    maxBytes: number,
    ownerId?: string,
    retentionClass?: RetentionClass
  ): Promise<string> {
    // Validate uploadId is a UUID to prevent path traversal.
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    return this.withUploadLock(uploadId, async () => {
      // A `complete` asked again for a session that already produced its object answers with the
      // SAME id (a lost or abandoned response, a client retry) - never a second stored copy. The lock
      // serialises it behind a first call still assembling, so the memo is read after it lands.
      const done = await this.readCompletedChunkUpload(uploadId);
      if (done) {
        if (done.ownerId !== ownerId) throw new ForbiddenException('Not your upload session');
        this.logger.log(
          `Chunked upload ${uploadId} completed again: answering the same ${done.mediaId}`
        );
        return done.mediaId;
      }
      const session = this.chunkSessions?.get(uploadId);
      // THE OPENER IS KEPT ACROSS A FAILED COMPLETE (the staged bytes stay for the re-ask), so a
      // member who merely knows the uploadId cannot assemble another's bytes under their own name.
      // Forgotten only on success, abort, an over-cap append or the sweep. Unknown after a restart.
      const opener = this.chunkOwners?.get(uploadId) ?? session?.ownerId;
      if (opener && opener !== ownerId) {
        // Not the member who opened (and reserved for) this session.
        this.logger.warn(`Chunked upload ${uploadId} completed by another member than its opener`);
        throw new ForbiddenException('Not your upload session');
      }
      // THE RESERVATION IS HELD UNTIL THE ENTRY IS REGISTERED, whichever way this ends.
      let release: () => void = () => {};
      try {
        const tempFile = this.chunkTempPath(uploadId);
        if (!(await fs.pathExists(tempFile))) {
          throw new NotFoundException('Upload session not found or expired');
        }

        const stat = await fs.stat(tempFile);
        if (stat.size > maxBytes) {
          await fs.remove(tempFile);
          this.chunkOwners?.delete(uploadId);
          throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
        }
        if (!(session && retentionClass === 'chat-reel')) {
          // No declaration at init (or another class): checked here, at assembly. A declared
          // session is already covered by its own reservation, appends being capped to it.
          try {
            release = this.reserveChatReelBudget(retentionClass, ownerId, stat.size);
          } catch (err) {
            // The member is over their daily budget: the staged bytes are of no use to anyone.
            await fs.remove(tempFile);
            this.chunkOwners?.delete(uploadId);
            throw err;
          }
        }
        const mediaId = uuidv4();

        await this.storage.putFileStream(mediaId, tempFile, stat.size);

        this.setAccess(mediaId, Date.now(), ownerId, retentionClass, stat.size);
        // THE RECORD IS WRITTEN BEFORE THE STAGING IS REMOVED: a crash between the two leaves the
        // record (a re-ask answers from it) and the staging (swept at 24 h), never neither.
        const recorded = await this.writeCompletedChunkUpload(uploadId, { mediaId, ownerId });
        // Entry registered: the reservation hands over to it in this same synchronous run.
        release();
        this.dropChunkSession(uploadId);
        if (recorded) {
          await fs.remove(tempFile);
          this.chunkOwners?.delete(uploadId);
        } else {
          // NO RECORD, SO THE STAGING IS THE ONLY THING A RE-ASK CAN ANSWER FROM: it stays, with
          // its opener, so the re-ask re-assembles under the opener check (never a 404 for a
          // member whose answer was lost). The 24 h sweep takes both if nobody comes back.
          this.logger.warn(
            `Chunked upload ${uploadId}: completed as ${mediaId} but unrecorded, staging kept for a re-ask`
          );
        }
        await this.persistMetadata();

        return mediaId;
      } finally {
        release();
        this.dropChunkSession(uploadId);
      }
    });
  }

  /**
   * THE ANSWER OF A COMPLETED LEGACY SESSION, kept as a sidecar file next to the staging
   * (`<uploadId>.done`) so a `complete` whose answer was lost, and is asked again, gets the SAME
   * mediaId instead of storing the object twice. On disk, not in memory, so it survives a restart or
   * a redeploy (the common moment for a lost answer); it ages out with the 24 h orphan sweep, which
   * is also the lifetime of the session it answers for. A failure is logged and reported as
   * `false`, never thrown: the caller then KEEPS the staging, which is what a re-ask answers from.
   */
  private async writeCompletedChunkUpload(
    uploadId: string,
    done: { mediaId: string; ownerId?: string }
  ): Promise<boolean> {
    try {
      // Temp + rename: a reader sees the whole record or none, never a truncated one.
      const target = `${this.chunkTempPath(uploadId)}.done`;
      await fs.writeFile(`${target}.tmp`, JSON.stringify(done));
      await fs.rename(`${target}.tmp`, target);
      return true;
    } catch (err) {
      this.logger.warn(
        `Chunked upload ${uploadId}: could not record its completion: ${String(err)}`
      );
      return false;
    }
  }

  private async readCompletedChunkUpload(
    uploadId: string
  ): Promise<{ mediaId: string; ownerId?: string } | null> {
    const file = `${this.chunkTempPath(uploadId)}.done`;
    if (!(await fs.pathExists(file))) return null;
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as { mediaId: string; ownerId?: string };
    } catch (err) {
      this.logger.warn(`Chunked upload ${uploadId}: unreadable completion record: ${String(err)}`);
      return null;
    }
  }

  /**
   * Serializes concurrent operations on the same uploadId to prevent TOCTOU races.
   * A lightweight chain-of-promises mutex: each new operation waits for the previous to finish.
   */
  private async withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.uploadLocks.get(uploadId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.uploadLocks.set(uploadId, nextLock);
    await prior;
    try {
      return await fn();
    } finally {
      releaseLock();
      if (this.uploadLocks.get(uploadId) === nextLock) {
        this.uploadLocks.delete(uploadId);
      }
    }
  }

  /** Resolved temp directory with trailing sep for stable prefix checks (path traversal defense). */
  private chunkDirRoot(): string {
    return path.resolve(CHUNK_DIR) + path.sep;
  }

  /**
   * Single temp file path for an upload UUID, confined under CHUNK_DIR.
   */
  private chunkTempPath(uploadId: string): string {
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    const resolved = path.resolve(CHUNK_DIR, uploadId);
    if (!resolved.startsWith(this.chunkDirRoot())) {
      throw new BadRequestException('Invalid upload path');
    }
    return resolved;
  }

  private loadMetadata() {
    try {
      if (!fs.existsSync(MEDIA_META_FILE)) return;
      const raw = fs.readJsonSync(MEDIA_META_FILE) as Partial<MediaMetadataStore>;
      const items = Object.create(null) as Record<string, MediaMetaEntry>;
      if (raw?.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
        for (const key of Object.keys(raw.items)) {
          if (!UUID_REGEX.test(key)) continue;
          const entry = raw.items[key];
          if (!entry || typeof entry !== 'object') continue;
          items[key] = entry;
        }
      }
      this.meta.items = items;
      if (this.backfillPublicAssetFlags()) {
        void this.persistMetadata();
      }
    } catch (error) {
      this.logger.warn(
        `Unable to read media metadata index: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async persistMetadata() {
    await fs.writeJson(MEDIA_META_FILE, { items: { ...this.meta.items } }, { spaces: 2 });
  }

  /** Reads an object storage stream into a single buffer. */
  private async readStreamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  /**
   * THE ALLOWLIST: true only for what the idle sweep may delete, which is the `ephemeral` class.
   *
   * Everything else is kept - every other class, an unclassified entry, a public asset - so a new
   * surface that forgets to name its class costs storage rather than a member's file. That
   * direction is the whole point: until 2026-10-01 this was a list of EXEMPTIONS, and an
   * association's vault document, which no exemption named, was swept on production.
   *
   * The sweep and `getStorageStats` both call THIS and nothing else, so the overdue count stays a
   * verdict on the sweep rather than an estimate of it.
   */
  private isSweepable(entry: MediaMetaEntry | undefined): boolean {
    if (!entry) return false;
    return (
      (entry.retentionClass === 'ephemeral' || entry.retentionClass === 'chat-reel') &&
      !this.isPublicAssetEntry(entry)
    );
  }

  /**
   * Whether a sweepable entry's OWN clock has run out: an `ephemeral` object when nobody has read it
   * for {@link RETENTION_MS}, a `chat-reel` when {@link CHAT_REEL_RETENTION_MS} has passed since it
   * was UPLOADED (reading it moves nothing). One function, used by the sweep and by the stats'
   * `overdue` figures, so the number stays a verdict on the sweep and not an estimate of it.
   */
  private isDue(entry: MediaMetaEntry, now: number): boolean {
    if (!this.isSweepable(entry)) return false;
    if (entry.retentionClass === 'chat-reel') {
      return entry.createdAt + CHAT_REEL_RETENTION_MS < now;
    }
    return entry.lastAccessAt < now - RETENTION_MS;
  }

  /**
   * True for objects that belong to something other than their uploader, so an account deletion
   * must not take them: public assets (a logo) and `association` vault documents.
   *
   * Deliberately NOT the inverse of {@link isSweepable}: an archived post photo is kept by the
   * sweep and still goes with its uploader's account.
   */
  private survivesAccountDeletion(entry: MediaMetaEntry): boolean {
    return this.isPublicAssetEntry(entry) || entry.retentionClass === 'association';
  }

  /** True for association logos and other plaintext images exempt from the retention sweep. */
  private isPublicAssetEntry(entry: MediaMetaEntry | undefined): boolean {
    if (!entry) return false;
    if (entry.publicAsset) return true;
    const ct = entry.contentType?.toLowerCase() ?? '';
    return ct.startsWith('image/');
  }

  /**
   * Marks legacy image rows as public (e.g. uploaded before `publicAsset` was persisted).
   * Prevents association logos from being deleted by the retention job.
   */
  private backfillPublicAssetFlags(): boolean {
    let changed = false;
    for (const [mediaId, entry] of Object.entries(this.meta.items)) {
      if (entry.purgedAt || entry.publicAsset) continue;
      if (!this.isLikelyPublicImageEntry(entry)) continue;
      entry.publicAsset = true;
      changed = true;
      this.logger.log(`Backfilled publicAsset flag for ${mediaId}`);
    }
    return changed;
  }

  private isLikelyPublicImageEntry(entry: MediaMetaEntry): boolean {
    const ct = entry.contentType?.toLowerCase() ?? '';
    return ct.startsWith('image/');
  }

  /**
   * Records an access, and the owner on the FIRST write only - `setAccess` also runs on every
   * download, where no uploader is in scope, so an ownerless call must never erase one.
   */
  private setAccess(
    mediaId: string,
    now: number,
    ownerId?: string,
    retentionClass?: RetentionClass,
    size?: number
  ) {
    const current = this.meta.items[mediaId];
    this.meta.items[mediaId] = {
      ...current,
      createdAt: current?.createdAt ?? now,
      lastAccessAt: now,
      ...(ownerId ? { ownerId } : {}),
      // Written for a `chat-reel` only (the daily cap sums it); `download()` passes none.
      ...(size !== undefined && retentionClass === 'chat-reel' ? { size } : {}),
      // Conditional for the same reason as ownerId: `download()` and `touch()` call this with
      // neither argument, and an unconditional spread would strip the class on every read.
      ...(retentionClass ? { retentionClass } : {}),
    };
  }

  private async purgeExpiredMedia() {
    const now = Date.now();
    let purgedCount = 0;

    for (const [mediaId, entry] of Object.entries(this.meta.items)) {
      if (entry.purgedAt) continue;
      if (!this.isDue(entry, now)) continue;

      try {
        await this.storage.delete(mediaId);
      } catch (err) {
        // Still marked purged below - the object may simply be absent already. But this branch is
        // how a blob is STRANDED: the entry becomes a tombstone, the tombstone is trimmed after
        // META_TOMBSTONE_MAX_AGE_MS, and the sweep only ever iterates the metadata - so an object
        // whose delete failed here can never be seen again. Measured 2026-08-11: 7 of the 26 live
        // objects on production have no metadata entry at all. Never swallow it silently.
        this.logger.warn(
          `Retention delete failed for ${mediaId} (object may be stranded): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      this.meta.items[mediaId] = {
        createdAt: entry.createdAt,
        lastAccessAt: entry.lastAccessAt,
        purgedAt: now,
        purgeReason: entry.retentionClass === 'chat-reel' ? 'reel_expired' : 'retention_expired',
      };
      purgedCount += 1;
    }

    // Remove tombstone entries (purgedAt != null) older than META_TOMBSTONE_MAX_AGE_MS.
    // Prevents the metadata JSON from growing unbounded after many retention cycles.
    let trimmedCount = 0;
    for (const [mediaId, entry] of Object.entries(this.meta.items)) {
      if (entry.purgedAt && now - entry.purgedAt > META_TOMBSTONE_MAX_AGE_MS) {
        delete this.meta.items[mediaId];
        trimmedCount += 1;
      }
    }

    if (purgedCount > 0 || trimmedCount > 0) {
      await this.persistMetadata();
      // Both windows are interpolated, never spelled: these two lines said "30 days" and
      // "> 90 days" in prose next to the constants they were meant to report, which is one edit
      // away from a log that lies about the policy it is enforcing.
      if (purgedCount > 0)
        this.logger.log(
          `Purged ${purgedCount} expired media object(s) (retention ${msToDays(RETENTION_MS)} days)`
        );
      if (trimmedCount > 0)
        this.logger.log(
          `Trimmed ${trimmedCount} metadata tombstone(s) > ${msToDays(META_TOMBSTONE_MAX_AGE_MS)} days`
        );
    }

    // Purge orphaned chunked upload temp files older than 24 hours.
    // These are left behind when a client starts a chunked upload but never completes it.
    await this.purgeOrphanedChunks();
  }

  /** Deletes temp files in CHUNK_DIR that are older than 24 hours (abandoned uploads). */
  private async purgeOrphanedChunks(): Promise<void> {
    const maxAgeMs = 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      const entries = await fs.readdir(CHUNK_DIR);
      for (const name of entries) {
        const filePath = path.join(CHUNK_DIR, name);
        try {
          const stat = await fs.stat(filePath);
          if (Date.now() - stat.mtimeMs > maxAgeMs) {
            await fs.remove(filePath);
            removed++;
          }
        } catch {
          // File may have been removed concurrently - ignore.
        }
      }
    } catch {
      // CHUNK_DIR may not exist yet on first run - ignore.
    }
    // A reservation must not outlive its staged file (swept above, or lost with the volume), and
    // neither must the record of who opened it.
    for (const uploadId of [
      ...(this.chunkSessions?.keys() ?? []),
      ...(this.chunkOwners?.keys() ?? []),
    ]) {
      if (!(await fs.pathExists(this.chunkTempPath(uploadId)))) {
        this.dropChunkSession(uploadId);
        this.chunkOwners?.delete(uploadId);
      }
    }
    if (removed > 0) {
      this.logger.log(`Purged ${removed} orphaned chunked upload temp file(s) (>24h)`);
    }
  }
}
