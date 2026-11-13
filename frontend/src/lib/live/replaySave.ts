/**
 * SAVING A LIVE REPLAY, LIKE A REEL (docs/wiki/live-replays.md section 2 step 7, WP-R5): ONE
 * fragmented MP4 built on the device - the first init, then every fragment - written SEGMENT BY
 * SEGMENT into the gallery staging (`reels/gallery.ts`, offset-checked chunks), never the whole
 * replay in memory. The replay is the live's own sealed segments: each is fetched, opened with the
 * live key and written, then dropped.
 *
 * WHEN A SEGMENT'S INIT DIFFERS from the one written (a camera re-acquired, a lens), the file is
 * closed and a SECOND PART starts (`canari-replay-<day>-<id8>-2.mp4`): two `moov` in one file is not a
 * valid MP4. A part is handed to the gallery as soon as it is closed, so a long replay never waits
 * for its end to start writing. On the web and the desktop app (no gallery) a part is collected and
 * handed to the browser's download - the one place a whole part is held in memory; the phone apps,
 * where the replay is long, never are.
 *
 * Whether a native player crosses a background GAP in the media timeline of one part is a reading
 * owed on the phones, not a fact (docs/wiki/live-replays.md, "The readings owed").
 */
import { fetchLiveReplay, fetchLiveSegment, isLiveRefusal } from './api';
import { LiveSegmentOpenError, openLiveSegment } from './liveCrypto';
import { initSegmentEnd } from './fmp4Segments';
import { sameBytes } from './livePlayer';
import { replayFileName } from './replayTimeline';
import type { LiveReplaySegment } from './types';
import {
  commitStaged,
  discardStaged,
  hasNativeGallery,
  stageBlobAt,
  type GallerySaveOutcome,
} from '$lib/reels/gallery';
import { saveBlobAs } from '$lib/utils/fileDownload';

/** A whole replay's list, every page read: what a save (and the size it announces) works from. */
export interface ReplayList {
  liveId: string;
  postId: string;
  key: string;
  segments: LiveReplaySegment[];
}

/** What a save came to: the worst outcome of its parts, and how many parts it wrote. */
export interface ReplaySaveResult {
  outcome: GallerySaveOutcome | 'downloaded' | 'cancelled';
  parts: number;
}

/** What a save needs from outside: the network, the seal, the platform's gallery and download. */
export interface SaveReplayDeps {
  fetchReplay: typeof fetchLiveReplay;
  fetchSegment: typeof fetchLiveSegment;
  openSegment: typeof openLiveSegment;
  hasNativeGallery: () => boolean;
  newSession: () => string;
  stage: (session: string, bytes: Uint8Array<ArrayBuffer>, offset: number) => Promise<number>;
  commit: (session: string, name: string, mime: string) => Promise<GallerySaveOutcome>;
  discard: (session: string, cause: unknown) => Promise<never>;
  saveBlobAs: (blob: Blob, name: string) => Promise<boolean>;
}

const defaultDeps: SaveReplayDeps = {
  fetchReplay: fetchLiveReplay,
  fetchSegment: fetchLiveSegment,
  openSegment: openLiveSegment,
  hasNativeGallery,
  newSession: () => crypto.randomUUID(),
  stage: (session, bytes, offset) => stageBlobAt(session, new Blob([bytes]), offset),
  commit: commitStaged,
  discard: discardStaged,
  saveBlobAs,
};

/**
 * Reads every page of a replay's list. The size a save announces comes from it, BEFORE anything is
 * written. @throws the typed `LiveRefusalError` (`not-found`: the replay expired or is withheld).
 */
export async function loadReplayList(
  liveId: string,
  deps: Pick<SaveReplayDeps, 'fetchReplay'> = defaultDeps
): Promise<ReplayList> {
  console.debug(`[LIVE_REPLAY] save: listing ${liveId}`);
  const segments: LiveReplaySegment[] = [];
  let key = '';
  let postId = '';
  let from: number | null = 0;
  while (from !== null) {
    const page = await deps.fetchReplay(liveId, from === 0 ? undefined : from);
    key = page.key;
    postId = page.postId;
    segments.push(...page.segments);
    from = page.nextFrom;
  }
  console.debug(`[LIVE_REPLAY] save: ${segments.length} segments listed for ${liveId}`);
  return { liveId, postId, key, segments };
}

/** One part being written: the init it began with, its session, and how far the file got. */
interface OpenPart {
  init: Uint8Array;
  number: number;
  session: string;
  offset: number;
  /** Web / desktop only: the pieces of the part, held until it is handed to the download. */
  held: Uint8Array<ArrayBuffer>[];
}

/**
 * Saves `list` as one file, or several when the init changes. `publishedAt` is the replay's day (the
 * file name's). @throws {GalleryError} when the platform could not take a part;
 * {@link LiveSegmentOpenError} when the segments do not open (the key or the bytes are wrong); the
 * typed refusal of a fetch that failed.
 */
export async function saveReplay(
  list: ReplayList,
  publishedAt: string,
  deps: SaveReplayDeps = defaultDeps
): Promise<ReplaySaveResult> {
  const native = deps.hasNativeGallery();
  console.debug(
    `[LIVE_REPLAY] save ${list.liveId}: ${list.segments.length} segments, ${native ? 'gallery' : 'download'}`
  );
  let part: OpenPart | null = null;
  let parts = 0;
  let skipped = 0;
  let openFailures = 0;
  let worst = (native ? 'saved' : 'downloaded') as ReplaySaveResult['outcome'];

  /** Hands the open part to the platform and records a refusal. */
  const closePart = async (p: OpenPart): Promise<void> => {
    const name = replayFileName(list.postId, publishedAt, p.number);
    if (native) {
      const outcome = await deps.commit(p.session, name, 'video/mp4');
      if (outcome === 'denied') worst = 'denied';
      return;
    }
    const taken = await deps.saveBlobAs(new Blob(p.held), name);
    if (!taken) worst = 'cancelled';
    p.held = [];
  };

  /** Writes `bytes` to the open part: staged on a phone, held on the web. */
  const write = async (p: OpenPart, bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    if (!native) {
      p.held.push(bytes);
      return;
    }
    try {
      p.offset = await deps.stage(p.session, bytes, p.offset);
    } catch (err) {
      await deps.discard(p.session, err);
    }
  };

  for (const s of list.segments) {
    let sealed: ArrayBuffer;
    try {
      sealed = await deps.fetchSegment(list.liveId, s.name);
    } catch (e) {
      if (!isLiveRefusal(e, 'not-found')) throw e;
      console.warn(`[LIVE_REPLAY] save ${list.liveId}: segment ${s.index} is gone - skipped`);
      skipped++;
      continue;
    }
    let media: Uint8Array<ArrayBuffer>;
    try {
      media = await deps.openSegment(list.key, list.liveId, s.index, sealed);
      openFailures = 0;
    } catch (e) {
      if (!(e instanceof LiveSegmentOpenError)) throw e;
      openFailures++;
      console.error(
        `[LIVE_REPLAY] save ${list.liveId}: segment ${s.index} did not open (${openFailures} in a row)`
      );
      if (openFailures >= 3 || part === null) throw e;
      skipped++;
      continue;
    }
    const end = initSegmentEnd(media);
    const init = end > 0 ? media.slice(0, end) : null;
    if (part === null || (init !== null && !sameBytes(init, part.init))) {
      if (init === null) {
        // The first segment kept has no init to start a file on: nothing playable can be written.
        throw new LiveSegmentOpenError('malformed', s.index, media.byteLength);
      }
      if (part !== null) {
        console.debug(
          `[LIVE_REPLAY] save ${list.liveId}: a new init at segment ${s.index} - part ${part.number + 1}`
        );
        await closePart(part);
        part = null;
        if (worst === 'denied') break;
      }
      parts++;
      part = { init, number: parts, session: deps.newSession(), offset: 0, held: [] };
      await write(part, media);
      continue;
    }
    // Same init: the file already has it, so only the fragment is written.
    await write(part, media.slice(end));
  }
  if (part !== null) await closePart(part);
  if (worst === 'denied') {
    console.debug(`[LIVE_REPLAY] save ${list.liveId}: gallery access refused - stopped`);
  }
  console.log(
    `[LIVE_REPLAY] save ${list.liveId}: ${worst}, ${parts} part(s), ${skipped} segment(s) skipped`
  );
  return { outcome: worst, parts };
}
