/**
 * THE VIEWER'S LOOK-AHEAD (owner, 2026-11-11: the next 2-3 media fetched in parallel). What it must
 * guarantee, counted: three pages ahead on a link that keeps up with the media and one on a link
 * that does not (#3333's verdict and hysteresis, no clock); a page passed is dropped at once, its
 * request aborted; a page that becomes the one on screen keeps its fetch for its player to join; and
 * nothing fetched ahead takes the media gate's last slot.
 */
import { vi } from 'vitest';
import type { PostEntity, PostMediaRef } from '$lib/posts/api';
import type { MediaHeadHold } from '$lib/utils/mediaHeadStore';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('./reelPosters.svelte', () => ({
  captureReelPoster: async () => {},
  reelPosterUrl: () => null,
}));

const {
  ReelAhead,
  aheadPagesOf,
  aheadCountFor,
  lookAheadLinkSlow,
  resetLookAheadForTest,
  REEL_AHEAD_FAST,
  REEL_AHEAD_SLOW,
} = await import('./reelAhead');
const { sessionLinkRate } = await import('$lib/utils/linkRate');
const { holdMediaHead, setHeadFetchForTest } = await import('$lib/utils/mediaHeadStore');
const { mediaRequestGate } = await import('$lib/utils/requestGate');

/** A reel of 20 s weighing 2.5 MB: 125 kB of media per second. */
const MEDIA_RATE = 125_000;

function video(id: string): PostMediaRef {
  return {
    type: 'video',
    mediaId: `m-${id}`,
    key: 'k',
    iv: 'i',
    mimeType: 'video/mp4',
    size: MEDIA_RATE * 20,
    encoding: 'segmented-v1',
  };
}

function picture(id: string): PostMediaRef {
  return { type: 'image', mediaId: `m-${id}`, key: 'k', iv: 'i', mimeType: 'image/webp', size: 1 };
}

function post(id: string, media: PostMediaRef[], kind: 'reel' | 'post' = 'reel'): PostEntity {
  return {
    id,
    kind,
    markdown: '',
    mentions: [],
    links: [],
    media,
    images: [],
    polls: [],
    authorId: 'u',
    createdAt: '2026-11-11T00:00:00Z',
    publishedAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
    durationMs: kind === 'reel' ? 20_000 : null,
  } as PostEntity;
}

/** A recorded world: which heads and pictures are held, released, aborted. */
function world() {
  const heads = new Map<
    string,
    { release: ReturnType<typeof vi.fn>; resolve: (b: Uint8Array<ArrayBuffer>) => void }
  >();
  const pictures = new Map<string, AbortSignal>();
  const released: string[] = [];
  const frames: string[] = [];
  const deps = {
    holdHead: (mediaId: string): MediaHeadHold => {
      let resolve: (b: Uint8Array<ArrayBuffer>) => void = () => {};
      const bytes = new Promise<Uint8Array<ArrayBuffer>>((r) => (resolve = r));
      const release = vi.fn(() => released.push(mediaId));
      heads.set(mediaId, { release, resolve });
      return { bytes, release };
    },
    acquirePicture: (ref: PostMediaRef, signal: AbortSignal) => {
      pictures.set(ref.mediaId, signal);
      return new Promise<string>(() => {});
    },
    releasePicture: vi.fn(),
    keepFirstFrame: async (ref: PostMediaRef) => void frames.push(ref.mediaId),
    hasFirstFrame: () => false,
  };
  return { deps, heads, pictures, released, frames };
}

const reels = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => post(id, [video(id)]));

beforeEach(() => {
  resetLookAheadForTest();
  sessionLinkRate.reset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setHeadFetchForTest(null);
});

describe('how many pages ahead', () => {
  it('is three on a fast link and one on a slow one', () => {
    expect(aheadCountFor(false)).toBe(REEL_AHEAD_FAST);
    expect(aheadCountFor(true)).toBe(REEL_AHEAD_SLOW);
    expect([REEL_AHEAD_FAST, REEL_AHEAD_SLOW]).toEqual([3, 1]);
  });

  it("follows #3333's verdict with its hysteresis: slow below 1x the media, fast again from 1.15x", () => {
    // Unknown: nothing measured, one page.
    expect(lookAheadLinkSlow(MEDIA_RATE, null)).toBe(true);
    expect(lookAheadLinkSlow(MEDIA_RATE, MEDIA_RATE * 1.1)).toBe(true);
    expect(lookAheadLinkSlow(MEDIA_RATE, MEDIA_RATE * 1.2)).toBe(false);
    expect(lookAheadLinkSlow(MEDIA_RATE, MEDIA_RATE * 1.05)).toBe(false);
    expect(lookAheadLinkSlow(MEDIA_RATE, MEDIA_RATE * 0.9)).toBe(true);
    // No reference media (a page of pictures): the last answer stands.
    expect(lookAheadLinkSlow(null, MEDIA_RATE * 10)).toBe(true);
  });

  it('fetches one page ahead before any measure, three once the link is measured fast', () => {
    const { deps, heads } = world();
    const ahead = new ReelAhead(deps);
    const plan = aheadPagesOf({ reels, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    expect([...heads.keys()]).toEqual(['m-b']);

    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    ahead.update(plan.current, plan.next);
    expect([...heads.keys()]).toEqual(['m-b', 'm-c', 'm-d']);
    ahead.stop();
  });

  it('drops to one page ahead when the link is measured slow', () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const { deps, released } = world();
    const ahead = new ReelAhead(deps);
    const plan = aheadPagesOf({ reels, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    expect(ahead.size).toBe(3);
    sessionLinkRate.reset();
    sessionLinkRate.observe(MEDIA_RATE, 2);
    sessionLinkRate.observe(MEDIA_RATE, 2);
    ahead.update(plan.current, plan.next);
    expect(ahead.size).toBe(1);
    expect(released.sort()).toEqual(['m-c', 'm-d']);
    ahead.stop();
  });
});

describe('what is fetched', () => {
  it("a carousel's remembered media, a picture whole, a single-block video nothing", () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const { deps, heads, pictures } = world();
    const list = [
      post('a', [video('a')]),
      post('car', [picture('c0'), video('c1')], 'post'),
      post('pic', [picture('p')], 'post'),
      post('old', [{ ...video('old'), encoding: undefined }], 'post'),
    ];
    const ahead = new ReelAhead(deps);
    const plan = aheadPagesOf({ reels: list, index: 0, mediaIndexById: { car: 1 } });
    ahead.update(plan.current, plan.next);
    expect([...heads.keys()]).toEqual(['m-c1']);
    expect([...pictures.keys()]).toEqual(['m-p']);
    expect(ahead.holds('m-old')).toBe(false);
    ahead.stop();
  });

  it("decodes each head's first frame once it is in", async () => {
    const { deps, heads, frames } = world();
    const ahead = new ReelAhead(deps);
    const plan = aheadPagesOf({ reels, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    heads.get('m-b')!.resolve(new Uint8Array(10));
    await vi.waitFor(() => expect(frames).toEqual(['m-b']));
    ahead.stop();
  });
});

describe('a fast scroll', () => {
  it('drops every page it passed before its fetch ended, and keeps the one landed on', () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const { deps, released } = world();
    const ahead = new ReelAhead(deps);
    for (let index = 0; index <= 4; index++) {
      const plan = aheadPagesOf({ reels, index, mediaIndexById: {} });
      ahead.update(plan.current, plan.next);
    }
    // On page 4 (e): b, c, d were passed and dropped; e is on screen and kept for its player; f ahead.
    expect(released.sort()).toEqual(['m-b', 'm-c', 'm-d']);
    expect(ahead.holds('m-e')).toBe(true);
    expect(ahead.holds('m-f')).toBe(true);
    ahead.stop();
    expect(released.sort()).toEqual(['m-b', 'm-c', 'm-d', 'm-e', 'm-f']);
  });

  it("abandons a passed picture's wait", () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const { deps, pictures } = world();
    const list = [post('a', [video('a')]), post('p', [picture('p')], 'post'), ...reels.slice(1)];
    const ahead = new ReelAhead(deps);
    let plan = aheadPagesOf({ reels: list, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    plan = aheadPagesOf({ reels: list, index: 2, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    expect(pictures.get('m-p')!.aborted).toBe(true);
    ahead.stop();
  });

  it('leaves no request on the wire for a page passed, through the real head store', async () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const signals = new Map<string, AbortSignal>();
    setHeadFetchForTest(
      (mediaId, _base, signal) =>
        new Promise((_, reject) => {
          signals.set(mediaId, signal);
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    const { deps } = world();
    const ahead = new ReelAhead({
      ...deps,
      holdHead: (id) => holdMediaHead(id, 'https://media.test'),
    });
    let plan = aheadPagesOf({ reels, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    plan = aheadPagesOf({ reels, index: 3, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    expect(signals.get('m-b')!.aborted).toBe(true);
    expect(signals.get('m-c')!.aborted).toBe(true);
    expect(signals.get('m-d')!.aborted).toBe(false); // now on screen
    ahead.stop();
    expect(signals.get('m-d')!.aborted).toBe(true);
  });
});

describe('the gate', () => {
  it('never puts more ahead on the wire than the background lane admits, foreground first', async () => {
    sessionLinkRate.observe(10 * MEDIA_RATE, 1);
    const ranges: string[] = [];
    const answers: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            ranges.push((init.headers as Record<string, string>).Range);
            answers.push(() => resolve(new Response(new Uint8Array(4), { status: 206 })));
          })
      )
    );
    // The page on screen holds one slot.
    let releaseCurrent: () => void = () => {};
    const current = mediaRequestGate.run(() => new Promise<void>((r) => (releaseCurrent = r)));
    const { deps } = world();
    const ahead = new ReelAhead({
      ...deps,
      holdHead: (id) => holdMediaHead(id, 'https://media.test'),
    });
    const plan = aheadPagesOf({ reels, index: 0, mediaIndexById: {} });
    ahead.update(plan.current, plan.next);
    await vi.waitFor(() => expect(ranges).toHaveLength(1));
    // Three heads wanted, ONE on the wire: the third slot stays free for what is on screen.
    expect(mediaRequestGate.inFlight).toBe(2);
    expect(mediaRequestGate.queued).toBe(2);
    let fg = false;
    const front = mediaRequestGate.run(async () => void (fg = true));
    await Promise.resolve();
    expect(fg).toBe(true);
    await front;
    ahead.stop();
    releaseCurrent();
    await current;
    for (const answer of answers) answer();
    vi.unstubAllGlobals();
  });
});
