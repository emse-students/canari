import { Injectable, Logger, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { StorageService } from './storage.service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Readable } from 'stream';

/** UUID v4 pattern — used to validate user-supplied IDs before path joins and property accesses. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CHUNK_DIR = path.join(process.cwd(), 'chunks_temp');
// Stored in a dedicated directory so it can be mounted as a named Docker volume
// and survive container restarts / redeployments.
const MEDIA_DATA_DIR = path.join(process.cwd(), 'media_meta');
const MEDIA_META_FILE = path.join(MEDIA_DATA_DIR, 'media_metadata.json');
/** Encrypted chat media blobs are purged after this idle period. Public assets are never purged. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;

type PurgeReason = 'retention_expired' | 'manual_delete';

interface MediaMetaEntry {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: PurgeReason;
  /** Plaintext object served at GET /api/media/public/:id without JWT; exempt from retention purge. */
  publicAsset?: boolean;
  contentType?: string;
}

interface MediaMetadataStore {
  items: Record<string, MediaMetaEntry>;
}

type DownloadResult =
  | { status: 'ok'; data: Buffer }
  | { status: 'not_found' }
  | { status: 'purged' };

type PublicDownloadResult =
  | { status: 'ok'; data: Buffer; contentType: string }
  | { status: 'not_found' };

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  /** Null-prototype map of media UUID → meta; avoids prototype pollution when loading JSON. */
  private readonly meta: MediaMetadataStore = { items: Object.create(null) };
  /** Per-uploadId locks that serialize concurrent chunk writes to prevent TOCTOU races. */
  private readonly uploadLocks = new Map<string, Promise<void>>();
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

  async upload(encryptedBytes: Buffer): Promise<string> {
    const mediaId = uuidv4();
    await this.storage.put(mediaId, encryptedBytes, encryptedBytes.length);
    this.setAccess(mediaId, Date.now());
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
    if (entry?.purgedAt && entry.purgeReason === 'retention_expired') {
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

    // Fallback: metadata lost after a container restart (media_metadata.json not persisted).
    // If the blob still exists in storage, serve it and backfill the metadata entry.
    // All logos/event images are converted to WebP on upload, so content-type is safe to assume.
    if (!entry?.purgedAt) {
      const stream = await this.storage.get(mediaId);
      if (stream) {
        const data = await this.readStreamToBuffer(stream);
        const now = Date.now();
        this.meta.items[mediaId] = {
          createdAt: now,
          lastAccessAt: now,
          publicAsset: true,
          contentType: 'image/webp',
        };
        await this.persistMetadata();
        this.logger.warn(`media ${mediaId}: metadata missing — backfilled from storage`);
        return { status: 'ok', data, contentType: 'image/webp' };
      }
    }

    return { status: 'not_found' };
  }

  async remove(mediaId: string): Promise<void> {
    // Validate mediaId is a UUID to prevent prototype pollution via property key injection.
    if (!UUID_REGEX.test(mediaId)) {
      throw new BadRequestException('Invalid mediaId');
    }
    await this.storage.delete(mediaId);
    const now = Date.now();
    const current = this.meta.items[mediaId];
    this.meta.items[mediaId] = {
      createdAt: current?.createdAt ?? now,
      lastAccessAt: current?.lastAccessAt ?? now,
      purgedAt: now,
      purgeReason: 'manual_delete',
    };
    await this.persistMetadata();
  }

  // --- Chunked upload ---

  async initChunkedUpload(): Promise<string> {
    const uploadId = uuidv4();
    const tempFile = this.chunkTempPath(uploadId);
    await fs.ensureFile(tempFile);
    return uploadId;
  }

  async appendChunk(uploadId: string, chunk: Buffer, maxBytes: number): Promise<void> {
    // Validate uploadId is a UUID to prevent path traversal (uncontrolled data in path).
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    // Serialize concurrent chunk writes for the same uploadId to prevent TOCTOU race conditions.
    await this.withUploadLock(uploadId, async () => {
      const tempFile = this.chunkTempPath(uploadId);
      if (!(await fs.pathExists(tempFile))) {
        throw new Error('Upload session not found or expired');
      }

      const stat = await fs.stat(tempFile);
      if (stat.size + chunk.length > maxBytes) {
        await fs.remove(tempFile);
        throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
      }

      await fs.appendFile(tempFile, chunk);
    });
  }

  async completeChunkedUpload(uploadId: string, maxBytes: number): Promise<string> {
    // Validate uploadId is a UUID to prevent path traversal.
    if (!UUID_REGEX.test(uploadId)) {
      throw new BadRequestException('Invalid uploadId');
    }
    return this.withUploadLock(uploadId, async () => {
      const tempFile = this.chunkTempPath(uploadId);
      if (!(await fs.pathExists(tempFile))) {
        throw new Error('Upload session not found or expired');
      }

      const stat = await fs.stat(tempFile);
      if (stat.size > maxBytes) {
        await fs.remove(tempFile);
        throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
      }
      const mediaId = uuidv4();

      await this.storage.putFileStream(mediaId, tempFile, stat.size);

      await fs.remove(tempFile);

      this.setAccess(mediaId, Date.now());
      await this.persistMetadata();

      return mediaId;
    });
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

  /** Reads a MinIO object stream into a single buffer. */
  private async readStreamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  /** True for association logos and other plaintext images exempt from the 30-day retention sweep. */
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

  private setAccess(mediaId: string, now: number) {
    const current = this.meta.items[mediaId];
    this.meta.items[mediaId] = {
      ...current,
      createdAt: current?.createdAt ?? now,
      lastAccessAt: now,
    };
  }

  private async purgeExpiredMedia() {
    const now = Date.now();
    const cutoff = now - RETENTION_MS;
    let purgedCount = 0;

    for (const [mediaId, entry] of Object.entries(this.meta.items)) {
      if (entry.purgedAt) continue;
      if (this.isPublicAssetEntry(entry)) continue;
      if (entry.lastAccessAt >= cutoff) continue;

      try {
        await this.storage.delete(mediaId);
      } catch {
        // Object may already be absent; still mark as purged in index.
      }

      this.meta.items[mediaId] = {
        createdAt: entry.createdAt,
        lastAccessAt: entry.lastAccessAt,
        purgedAt: now,
        purgeReason: 'retention_expired',
      };
      purgedCount += 1;
    }

    if (purgedCount > 0) {
      await this.persistMetadata();
      this.logger.log(`Purged ${purgedCount} expired media object(s) (retention 30 days)`);
    }
  }
}
