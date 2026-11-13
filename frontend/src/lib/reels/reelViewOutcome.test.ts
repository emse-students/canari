/**
 * The one line a reel view ends in: the first frame and its time, or the last stage the load
 * reached. Driven by an injected clock and plain stand-ins for the element, never by a wall clock.
 */
import { describe, expect, it } from 'vitest';
import { ReelView, reelSourceKind, reelViewStoppedAt, type ReelViewStart } from './reelViewOutcome';

const start: ReelViewStart = {
  postId: 'p1',
  mediaId: 'm1',
  source: 'stream',
  size: 28_000_000,
  preload: 'none',
};

function clock() {
  let t = 1000;
  return { now: () => t, at: (ms: number) => (t = 1000 + ms) };
}

const element = (readyState = 0, networkState = 2) => ({
  readyState,
  networkState,
  error: null,
  paused: false,
});

describe('reelSourceKind', () => {
  it('names a stream, or a whole read with its reason', () => {
    expect(reelSourceKind({ kind: 'blob', reason: 'no-codecs' })).toBe('whole (no-codecs)');
    expect(
      reelSourceKind({ kind: 'stream', MediaSourceCtor: undefined as never, managed: false })
    ).toBe('stream');
  });
});

describe('ReelView', () => {
  it('a streamed reel that played: its first frame time, its segments, its buffering', () => {
    const c = clock();
    const view = new ReelView({ ...start, preload: 'ready' }, c.now);
    const el = element(4, 1);
    const progress = { segmentCount: 12, appended: 3, bytes: 3_100_000, trimmedBefore: 0 };
    c.at(20);
    view.event('loadstart', el, progress);
    c.at(500);
    view.event('loadedmetadata', el);
    c.at(840);
    view.event('loadeddata', el);
    view.event('playing', el);
    view.event('waiting', el);
    view.event('waiting', { ...el, paused: true });
    // A loop fires them again: the first time stands.
    c.at(5000);
    view.event('loadeddata', el);
    c.at(12_400);
    expect(view.end({ inFlight: 1, queued: 0 })).toBe(
      'post p1 media m1: first frame in 840 ms, left after 12.4 s - stream, 3/12 segment(s) 3.1 MB, preload ready, 1 buffering'
    );
  });

  it('a stream waiting for its header says so, with the gate and the element', () => {
    const c = clock();
    const view = new ReelView(start, c.now);
    view.event('loadstart', element(), {
      segmentCount: null,
      appended: 0,
      bytes: 0,
      trimmedBefore: 0,
    });
    c.at(34_200);
    expect(view.end({ inFlight: 3, queued: 2 })).toBe(
      'post p1 media m1: NO first frame, left after 34.2 s - stopped at: waiting for the file header - stream, 0/? segment(s) 0.0 MB, preload none, media gate 3 running 2 queued, element readyState 0 networkState 2'
    );
  });

  it('names every stage a load can stop at, in the order the bytes travel', () => {
    const c = clock();
    const whole = new ReelView({ ...start, source: 'whole (no-codecs)' }, c.now);
    expect(reelViewStoppedAt(whole.facts)).toBe('downloading the whole file');
    whole.downloaded();
    expect(reelViewStoppedAt(whole.facts)).toBe('file in, never handed to the element');
    whole.event('loadstart', element());
    expect(reelViewStoppedAt(whole.facts)).toBe('file handed to the element, no metadata decoded');
    whole.event('loadedmetadata', element(1));
    expect(reelViewStoppedAt(whole.facts)).toBe('metadata decoded, no frame');

    const streamed = new ReelView(start, c.now);
    expect(reelViewStoppedAt(streamed.facts)).toBe('stream never reached the element');
    const progress = { segmentCount: 4, appended: 0, bytes: 0, trimmedBefore: 0 };
    streamed.event('loadstart', element(), progress);
    expect(reelViewStoppedAt(streamed.facts)).toBe('header read, no segment appended');
    progress.appended = 1;
    expect(reelViewStoppedAt(streamed.facts)).toBe('segments appended, no metadata decoded');

    const failed = new ReelView(start, c.now);
    failed.failed('unreachable');
    failed.failed('other');
    expect(reelViewStoppedAt(failed.facts)).toBe('download failed (unreachable)');
  });

  it('a whole read that came in, and a frame that never played, are said', () => {
    const c = clock();
    const view = new ReelView({ ...start, source: 'whole (single-block)' }, c.now);
    c.at(2000);
    view.downloaded();
    view.event('loadeddata', element(2));
    view.wontPlay('refused');
    c.at(3000);
    expect(view.end()).toBe(
      'post p1 media m1: first frame in 2000 ms, left after 3000 ms - whole (single-block), 28.0 MB in after 2000 ms, preload none, will not play by itself (refused), never playing'
    );
  });
});
