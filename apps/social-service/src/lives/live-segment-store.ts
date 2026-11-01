import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import FormData from 'form-data';
import { firstValueFrom } from 'rxjs';
import { mediaUrl } from '../internal/service-urls';
import { LIVE_SEGMENT_MAX_BYTES } from './live.constants';

/** What `POST media/internal/live-purge` answers - see `LiveSegmentsService.purge` there. */
export interface LivePurgeResult {
  /** Objects deleted by this call. */
  deleted: number;
  /** Objects the store refused to delete. */
  failed: number;
  /** Objects still under the live's prefix AFTER the deletes, re-listed: 0 is the proof it is empty. */
  remaining: number;
}

/** What `POST media/internal/live-segments-delete` answers - see `LiveSegmentsService.deleteSegments` there. */
export interface LiveTrimResult {
  /** Names the store no longer holds (already absent counts). */
  deleted: string[];
  /** Names the store refused to delete: still stored. */
  failed: string[];
}

/** The injection token of the segment store, so a spec can hand the service an in-memory one. */
export const LIVE_SEGMENT_STORE = Symbol('LIVE_SEGMENT_STORE');

/**
 * Where a live's sealed segments are kept: the media store, under `live/<liveId>/<name>`. The
 * service never reads them back - viewers fetch them from media-service by the name the manifest
 * gives them.
 */
export interface LiveSegmentStore {
  /** Stores one segment. THROWS on any failure: an ingest must not record a segment it did not store. */
  store(liveId: string, name: string, data: Buffer): Promise<void>;
  /** Deletes every segment of a live and re-lists. THROWS on a transport failure. */
  purge(liveId: string): Promise<LivePurgeResult>;
  /** Deletes named segments of a RUNNING live (the trim behind its window). THROWS on a transport failure. */
  deleteSegments(liveId: string, names: string[]): Promise<LiveTrimResult>;
  /** The live ids that have a `live/<id>/` folder in the store - the orphan reaper's listing. */
  listLives(): Promise<string[]>;
}

const internalHeaders = () => ({ 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });

/** The media-service implementation, over its two internal live routes (X-Internal-Secret). */
@Injectable()
export class HttpLiveSegmentStore implements LiveSegmentStore {
  private readonly logger = new Logger(HttpLiveSegmentStore.name);

  constructor(private readonly http: HttpService) {}

  async store(liveId: string, name: string, data: Buffer): Promise<void> {
    this.logger.debug(`[LIVE] storing segment ${name} of live ${liveId} (${data.length} B)`);
    const fd = new FormData();
    fd.append('file', data, { filename: 'segment', contentType: 'application/octet-stream' });
    await firstValueFrom(
      this.http.post(mediaUrl(`media/internal/live/${liveId}/${name}`), fd, {
        headers: { ...fd.getHeaders(), ...internalHeaders() },
        maxBodyLength: LIVE_SEGMENT_MAX_BYTES + 65_536,
      })
    );
  }

  async purge(liveId: string): Promise<LivePurgeResult> {
    this.logger.debug(`[LIVE] purging the segments of live ${liveId}`);
    const res = await firstValueFrom(
      this.http.post<LivePurgeResult>(
        mediaUrl('media/internal/live-purge'),
        { liveId },
        { headers: internalHeaders() }
      )
    );
    const body = res.data;
    if (
      typeof body?.deleted !== 'number' ||
      typeof body.failed !== 'number' ||
      typeof body.remaining !== 'number'
    ) {
      // An answer that does not say "empty" is not a proof of empty: the caller keeps the row.
      throw new Error('the media service answered the live purge without its three counts');
    }
    return body;
  }

  async deleteSegments(liveId: string, names: string[]): Promise<LiveTrimResult> {
    this.logger.debug(`[LIVE_TRIM] deleting ${names.length} segment(s) of live ${liveId}`);
    const res = await firstValueFrom(
      this.http.post<LiveTrimResult>(
        mediaUrl('media/internal/live-segments-delete'),
        { liveId, names },
        { headers: internalHeaders() }
      )
    );
    const body = res.data;
    if (!Array.isArray(body?.deleted) || !Array.isArray(body.failed)) {
      // An answer that does not say what went is not a proof: the rows stay, the next pass asks again.
      throw new Error('the media service answered the live trim without its two lists');
    }
    return body;
  }

  async listLives(): Promise<string[]> {
    this.logger.debug('[LIVE] listing the live folders of the store');
    const res = await firstValueFrom(
      this.http.post<{ liveIds?: unknown }>(
        mediaUrl('media/internal/live-list'),
        {},
        { headers: internalHeaders() }
      )
    );
    const ids = res.data?.liveIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      // A listing that is not a list of ids reaps nothing: the caller acts only on what it names.
      throw new Error('the media service answered the live listing without its liveIds');
    }
    return ids as string[];
  }
}
