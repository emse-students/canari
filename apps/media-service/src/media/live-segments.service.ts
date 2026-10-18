import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Readable } from 'stream';
import { StorageService } from './storage.service';

/**
 * The largest live segment stored, in bytes - the same bound social-service's ingest applies
 * (`LIVE_SEGMENT_MAX_BYTES` there, docs/wiki/services/lives.md). Repeated here as the store's own
 * refusal, because this route must not trust its one caller to have bounded the body.
 */
export const LIVE_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Every object of every live lives under this prefix, and nothing else does. */
export const LIVE_PREFIX = 'live/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE SERVER-SIDE SWITCH OF THE LIVE FEATURE, the same variable social-service reads:
 * `LIVE_ENABLED=true` and nothing else opens the live routes; production renders `false`.
 */
export function isLiveEnabled(): boolean {
  return process.env.LIVE_ENABLED === 'true';
}

/** The answer of a live purge: what went, what the store refused, and a RE-LISTING after both. */
export interface LivePurgeResult {
  deleted: number;
  failed: number;
  /** Objects still under the live's prefix after the deletes: 0 is the proof the live is gone. */
  remaining: number;
}

/**
 * The sealed segments of lives (WP-L3, docs/wiki/services/lives.md), kept under
 * `live/<liveId>/<name>`.
 *
 * NOT IN THE METADATA INDEX, deliberately: a segment every few seconds would be a JSON rewrite of the
 * whole index every few seconds, and nothing here needs what the index records - the owner is the
 * live (social-service's row), the retention is the live's end, and the reaper is social-service's
 * live sweep, which purges by PREFIX. So the idle sweep never sees them (it iterates the index, and
 * takes `ephemeral` only), the account-deletion fan-out never sees them (an erased broadcaster's
 * live is ended by social-service, which then purges it), and the storage panel reports them on a
 * line of their own (`liveSegment*`) rather than as untracked.
 *
 * Both ids are uuids, checked here: they are path segments of an object key.
 */
@Injectable()
export class LiveSegmentsService {
  private readonly logger = new Logger(LiveSegmentsService.name);

  constructor(private readonly storage: StorageService) {}

  /** The prefix of one live's objects; refuses anything but a uuid. */
  static prefix(liveId: string): string {
    if (!UUID_RE.test(liveId)) throw new BadRequestException('live id must be a uuid');
    return `${LIVE_PREFIX}${liveId.toLowerCase()}/`;
  }

  /** The object key of one segment; refuses anything but two uuids. */
  static key(liveId: string, name: string): string {
    if (!UUID_RE.test(name)) throw new BadRequestException('segment name must be a uuid');
    return `${LiveSegmentsService.prefix(liveId)}${name.toLowerCase()}`;
  }

  /** Stores one sealed segment. Throws on a store failure: the caller must not count it. */
  async store(liveId: string, name: string, data: Buffer): Promise<void> {
    const key = LiveSegmentsService.key(liveId, name);
    this.logger.debug(`[LIVE] storing ${key} (${data.length} B)`);
    await this.storage.put(key, data, data.length);
  }

  /** One segment as a stream with its length, or 404. */
  async read(liveId: string, name: string): Promise<{ stream: Readable; size: number }> {
    const key = LiveSegmentsService.key(liveId, name);
    const size = await this.storage.size(key);
    const stream = size === null ? null : await this.storage.get(key);
    if (size === null || !stream) {
      this.logger.debug(`[LIVE] ${key} asked for and absent`);
      throw new NotFoundException('Live segment not found');
    }
    return { stream, size };
  }

  /**
   * The live ids that have a folder under `live/` - what social-service's orphan reaper compares
   * with its rows. One entry per folder (a delimiter listing), never one per segment; a folder whose
   * name is not a uuid is skipped with a warn, since nothing here writes one.
   */
  async listLives(): Promise<string[]> {
    const ids: string[] = [];
    for (const folder of await this.storage.listPrefixes(LIVE_PREFIX)) {
      const id = folder.slice(LIVE_PREFIX.length).replace(/\/$/, '');
      if (UUID_RE.test(id)) ids.push(id.toLowerCase());
      else this.logger.warn(`[LIVE_GC] ${folder} is not a live folder - left alone`);
    }
    this.logger.debug(`[LIVE_GC] ${ids.length} live folder(s) in the store`);
    return ids;
  }

  /**
   * Deletes every object under one live's prefix, then LISTS IT AGAIN and says how many remain.
   * A delete the store refuses is counted and logged, never thrown, so the caller always receives
   * the re-listing; social-service deletes its live row only on `failed === 0 && remaining === 0`.
   */
  async purge(liveId: string): Promise<LivePurgeResult> {
    const prefix = LiveSegmentsService.prefix(liveId);
    const result: LivePurgeResult = { deleted: 0, failed: 0, remaining: 0 };
    for (const object of await this.storage.listObjects(prefix)) {
      try {
        await this.storage.delete(object.id);
        result.deleted += 1;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(`[LIVE_GC] ${object.id} not deleted: ${String(e)}`);
      }
    }
    result.remaining = (await this.storage.listObjects(prefix)).length;
    this.logger.log(
      `[LIVE_GC] live ${liveId}: deleted=${result.deleted} failed=${result.failed} remaining=${result.remaining}`
    );
    return result;
  }
}
