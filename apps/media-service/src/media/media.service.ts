import {
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';

const CHUNK_DIR = path.join(process.cwd(), 'chunks_temp');
const MEDIA_META_FILE = path.join(process.cwd(), 'media_metadata.json');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;

type PurgeReason = 'retention_expired' | 'manual_delete';

interface MediaMetaEntry {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: PurgeReason;
}

interface MediaMetadataStore {
  items: Record<string, MediaMetaEntry>;
}

type DownloadResult =
  | { status: 'ok'; data: Buffer }
  | { status: 'not_found' }
  | { status: 'purged' };

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly meta: MediaMetadataStore = { items: {} };
  private readonly sweepIntervalMs = Number.parseInt(
    process.env.MEDIA_RETENTION_SWEEP_MS ?? `${DEFAULT_SWEEP_MS}`,
    10,
  );

  constructor(private readonly storage: StorageService) {
    fs.ensureDirSync(CHUNK_DIR);
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

  async download(mediaId: string): Promise<DownloadResult> {
    await this.purgeExpiredMedia();

    const entry = this.meta.items[mediaId];
    if (entry?.purgedAt && entry.purgeReason === 'retention_expired') {
      return { status: 'purged' };
    }

    const stream = await this.storage.get(mediaId);
    if (!stream) {
      return { status: 'not_found' };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    this.setAccess(mediaId, Date.now());
    await this.persistMetadata();
    return { status: 'ok', data: Buffer.concat(chunks) };
  }

  async remove(mediaId: string): Promise<void> {
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
    const tempFile = path.join(CHUNK_DIR, uploadId);
    await fs.ensureFile(tempFile);
    return uploadId;
  }

  async appendChunk(
    uploadId: string,
    chunk: Buffer,
    maxBytes: number,
  ): Promise<void> {
    // We assume sequential chunk upload for simplicity.
    // The client should await each part or we save per part_index and combine.
    // Given the context, sequential client uploads are easiest.
    const tempFile = path.join(CHUNK_DIR, uploadId);
    if (!(await fs.pathExists(tempFile))) {
      throw new Error('Upload session not found or expired');
    }

    const stat = await fs.stat(tempFile);
    if (stat.size + chunk.length > maxBytes) {
      await fs.remove(tempFile);
      throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
    }

    await fs.appendFile(tempFile, chunk);
  }

  async completeChunkedUpload(uploadId: string, maxBytes: number): Promise<string> {
    const tempFile = path.join(CHUNK_DIR, uploadId);
    if (!(await fs.pathExists(tempFile))) {
      throw new Error('Upload session not found or expired');
    }

    const stat = await fs.stat(tempFile);
    if (stat.size > maxBytes) {
      await fs.remove(tempFile);
      throw new PayloadTooLargeException('Chunked upload exceeds 100 MB policy');
    }
    const mediaId = uuidv4();

    // Stream from local temp file to MinIO
    await this.storage.putFileStream(mediaId, tempFile, stat.size);

    // Clean up
    await fs.remove(tempFile);

    this.setAccess(mediaId, Date.now());
    await this.persistMetadata();

    return mediaId;
  }

  private loadMetadata() {
    try {
      if (!fs.existsSync(MEDIA_META_FILE)) return;
      const raw = fs.readJsonSync(MEDIA_META_FILE) as Partial<MediaMetadataStore>;
      if (raw && raw.items && typeof raw.items === 'object') {
        this.meta.items = raw.items;
      }
    } catch (error) {
      this.logger.warn(`Unable to read media metadata index: ${String(error)}`);
    }
  }

  private async persistMetadata() {
    await fs.writeJson(MEDIA_META_FILE, this.meta, { spaces: 2 });
  }

  private setAccess(mediaId: string, now: number) {
    const current = this.meta.items[mediaId];
    this.meta.items[mediaId] = {
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
