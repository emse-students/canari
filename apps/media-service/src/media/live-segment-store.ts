/**
 * LiveSegmentStore - the sealed segments of lives, on a disk volume of their own (`live_segments`),
 * OUTSIDE the object store the nightly backup reads.
 *
 * WHY A SECOND STORE, AND WHY A DIRECTORY (live replays WP-R3, docs/wiki/live-replays.md, owner
 * decision D2 of 2026-11-09: "replays are never in backups"). `backup-objects.sh` snapshots the
 * whole `garage_data` volume, and Garage keeps an object as content-addressed blocks rather than
 * under its key, so no bucket or prefix of it can be left out of a snapshot. A live segment had to
 * leave Garage to leave the backup. A second Garage node would carry a container, two secrets, a key
 * and a bucket for what is, here, a directory of ~0.5 MB files with one writer: media-service is an
 * `exclusive` service (one container, recreated in place - docs/wiki/cicd.md), the same reason its
 * metadata index is one JSON file on `media_meta`. So the store is that volume's directory tree, and
 * the backup's volume list (an allowlist) never names it.
 *
 * Layout: the key `live/<liveId>/<name>` is the file `<root>/live/<liveId>/<name>`. The keys are
 * built and checked as two uuids by {@link LiveSegmentsService}; this class refuses anything outside
 * `live/` again, and any key that would resolve outside its root, as the store's own rule.
 *
 * Atomic writes: a segment is written to `<root>/.staging/` then RENAMED into place, so a reader
 * sees a whole segment or none. The staging directory is emptied at boot: with one process, nothing
 * at boot can still be writing there.
 *
 * Empty folders: deleting the last segment of a live removes its folder, so the folder listing the
 * orphan reaper reads names only lives that still hold bytes. No store races that rmdir: a live
 * still on air always keeps its newest 20 segments (the trim never empties it), and its purge runs
 * after its end and the drain of its uploads (social-service's live sweep).
 *
 * The interface is the subset of {@link StorageService} the live segments use, so
 * {@link LiveSegmentsService} reads the same over either store.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import { LIVE_KEY_PREFIX as STORE_PREFIX, type StoredObject } from './storage.service';

/** Where the store lives: `LIVE_SEGMENTS_DIR`, else `./live_segments` (the compose volume's mount). */
export function liveSegmentsRoot(): string {
  const configured = process.env.LIVE_SEGMENTS_DIR;
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'live_segments');
}

/** Whether a node error is "no such file or directory". */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

@Injectable()
export class LiveSegmentStore implements OnModuleInit {
  private readonly logger = new Logger(LiveSegmentStore.name);
  private readonly root: string;
  private readonly staging: string;

  /** No parameter, so Nest injects nothing: the root is {@link liveSegmentsRoot}, read once here. */
  constructor() {
    this.root = liveSegmentsRoot();
    this.staging = path.join(this.root, '.staging');
  }

  /** Creates the store's two directories and empties the staging one (one process: nothing is mid-write). */
  async onModuleInit(): Promise<void> {
    await fs.promises.mkdir(path.join(this.root, STORE_PREFIX), { recursive: true });
    await fs.promises.rm(this.staging, { recursive: true, force: true });
    await fs.promises.mkdir(this.staging, { recursive: true });
    this.logger.log(`[LIVE_STORE] live segments are stored under ${this.root} (not backed up)`);
  }

  /** The file of a key; refuses a key outside `live/` or one that would leave the root. */
  private fileOf(key: string): string {
    if (!key.startsWith(STORE_PREFIX)) {
      throw new Error(`live segment store holds ${STORE_PREFIX} keys only, refused ${key}`);
    }
    const file = path.resolve(this.root, key);
    if (!file.startsWith(path.join(this.root, STORE_PREFIX))) {
      throw new Error(`key ${key} resolves outside the live segment store`);
    }
    return file;
  }

  /** Stores one segment atomically: written in staging, then renamed into place. */
  async put(key: string, data: Buffer, size: number): Promise<void> {
    const file = this.fileOf(key);
    if (data.length !== size) {
      throw new Error(`live segment ${key}: ${data.length} bytes given, ${size} declared`);
    }
    const staged = path.join(this.staging, randomUUID());
    try {
      await fs.promises.writeFile(staged, data);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.rename(staged, file);
    } catch (err) {
      this.logger.error(`[LIVE_STORE] ${key} not stored: ${String(err)}`);
      await fs.promises.rm(staged, { force: true });
      throw err;
    }
  }

  /** The stored length of a segment, or null when there is none. */
  async size(key: string): Promise<number | null> {
    try {
      return (await fs.promises.stat(this.fileOf(key))).size;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * One segment as a stream, or null when there is none. The file is OPENED here, so a segment
   * purged between the caller's `size` and this read is a null, never a stream that errors later.
   */
  async get(key: string): Promise<Readable | null> {
    try {
      const handle = await fs.promises.open(this.fileOf(key), 'r');
      return handle.createReadStream();
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * Deletes one segment; an absent one is not a failure (idempotent, like the S3 delete). When it
   * was the folder's last file the folder goes too (see the class comment for why no store races it).
   */
  async delete(key: string): Promise<void> {
    const file = this.fileOf(key);
    await fs.promises.rm(file, { force: true });
    try {
      await fs.promises.rmdir(path.dirname(file));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err;
    }
  }

  /** Every segment whose key starts with `prefix` (`live/` or `live/<liveId>/`), with its size and time. */
  async listObjects(prefix = STORE_PREFIX): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    for (const folder of await this.listPrefixes(STORE_PREFIX)) {
      if (!folder.startsWith(prefix) && !prefix.startsWith(folder)) continue;
      for (const entry of await this.readDir(path.join(this.root, folder))) {
        if (!entry.isFile()) continue;
        const id = `${folder}${entry.name}`;
        if (!id.startsWith(prefix)) continue;
        try {
          const stat = await fs.promises.stat(path.join(this.root, id));
          objects.push({ id, size: stat.size, lastModifiedMs: stat.mtimeMs });
        } catch (err) {
          // Deleted between the listing and the stat: it is gone, which is what a listing reports.
          if (!isMissing(err)) throw err;
        }
      }
    }
    return objects;
  }

  /** The folders one level under `live/` (`live/<liveId>/`), the only prefix this store lists. */
  async listPrefixes(prefix: string): Promise<string[]> {
    if (prefix !== STORE_PREFIX) {
      throw new Error(`live segment store lists ${STORE_PREFIX} only, asked ${prefix}`);
    }
    const entries = await this.readDir(path.join(this.root, STORE_PREFIX));
    return entries.filter((e) => e.isDirectory()).map((e) => `${STORE_PREFIX}${e.name}/`);
  }

  /** A directory's entries, or none when it does not exist. */
  private async readDir(dir: string): Promise<fs.Dirent[]> {
    try {
      return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }
}
