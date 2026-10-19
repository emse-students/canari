/**
 * The live viewer's screens, mounted: connecting, playing with the LIVE badge and the time on air,
 * "live complet" with a retry that plays, the end, the neutral "indisponible", a reconnect that never
 * says "complet", the sound toggle, Escape and the X closing it, and the seat given back on close.
 * The player's outside world is faked (`deps`): no network, no MSE, no timer runs by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveViewer from './LiveViewer.svelte';
import { LiveRefusalError } from '$lib/live/api';
import type {
  LiveMediaSourceLike,
  LivePlayerDeps,
  LiveSourceBufferLike,
} from '$lib/live/livePlayer';
import type { LiveListItem } from '$lib/live/types';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => '',
  resolveUserDisplayName: async () => 'Ada',
}));
vi.mock('$lib/associations/api', () => ({ getAssociation: vi.fn() }));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const LIVE: LiveListItem = {
  id: '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b',
  broadcasterId: 'u1',
  associationId: null,
  startedAt: '2026-10-19T10:00:00.000Z',
};

function box(type: string, payload = 0): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, 8 + payload);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}

class FakeBuffer extends EventTarget implements LiveSourceBufferLike {
  updating = false;
  mode = '';
  end = 0;
  get buffered() {
    const end = this.end;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>) {
    if (String.fromCharCode(...data.subarray(4, 8)) !== 'moov') this.end += 2;
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
  remove() {
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}
class FakeSource extends EventTarget implements LiveMediaSourceLike {
  readyState = 'open';
  addSourceBuffer() {
    return new FakeBuffer();
  }
}

const refusal = (kind: LiveRefusalError['kind'], status: number, viewerCap: number | null = null) =>
  new LiveRefusalError(status, null, kind, kind, viewerCap, null, null);

let timers: (() => void)[];
let liveErrors: unknown[];
let manifestErrors: unknown[];
let deps: Partial<LivePlayerDeps>;
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  timers = [];
  liveErrors = [];
  manifestErrors = [];
  videoSound.setMuted(true);
  // happy-dom's media element does not play; the player only needs play() to answer.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  deps = {
    fetchLive: vi.fn(async () => {
      const e = liveErrors.shift();
      if (e) throw e;
      return { ...LIVE, lastSegmentAt: null, nextIndex: 2, key: 'ab'.repeat(32) };
    }),
    fetchManifest: vi.fn(async () => {
      const e = manifestErrors.shift();
      if (e) throw e;
      return {
        liveId: LIVE.id,
        nextIndex: 2,
        lastSegmentAt: '2026-10-19T10:01:05.000Z',
        serverNow: '2026-10-19T10:01:05.000Z',
        segments: [
          { index: 0, name: 'a', bytes: 1 },
          { index: 1, name: 'b', bytes: 1 },
        ],
      };
    }),
    fetchSegment: vi.fn(async (_id: string, name: string) => new TextEncoder().encode(name).buffer),
    // A self-contained segment, as the broadcaster uploads it: the init, then one fragment.
    openSegment: vi.fn(async () => {
      const segment = new Uint8Array(56);
      segment.set(box('ftyp', 4));
      segment.set(box('moov', 12), 12);
      segment.set(box('moof', 0), 32);
      segment.set(box('mdat', 8), 40);
      return segment;
    }),
    leaveSeat: vi.fn(async () => {}),
    mediaSource: () => ({
      name: 'MediaSource',
      create: () => new FakeSource(),
      isTypeSupported: () => true,
    }),
    attach: () => () => {},
    schedule: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render() {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LiveViewer, { target, props: { live: LIVE, onClose, deps } }));
  await settle();
  return { onClose };
}

const viewer = () => document.querySelector<HTMLElement>('[data-live-viewer]')!;
const stateOf = () => viewer().getAttribute('data-live-state');

describe('LiveViewer', () => {
  it('plays with the LIVE badge, the time on air, and a named dialog', async () => {
    await render();
    expect(stateOf()).toBe('playing');
    expect(viewer().getAttribute('role')).toBe('dialog');
    expect(viewer().getAttribute('aria-label')).toBe(m.live_viewer_label({ name: 'Ada' }));
    expect(document.querySelector('[data-live-badge]')).not.toBeNull();
    expect(document.querySelector('[data-live-elapsed]')?.textContent?.trim()).toBe('1:05');
    expect(document.activeElement).toBe(document.querySelector('[data-live-close]'));
  });

  it('"live complet" offers a retry that plays, and never takes the reconnect line', async () => {
    liveErrors.push(refusal('full', 503, 24));
    await render();
    expect(stateOf()).toBe('full');
    expect(viewer().textContent).toContain(m.live_viewer_full_title());
    expect(timers).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('[data-live-retry]')!.click();
    await settle();
    expect(stateOf()).toBe('playing');
  });

  it('seats-unavailable is a reconnect, never "complet"', async () => {
    liveErrors.push(refusal('seats-unavailable', 503));
    await render();
    expect(stateOf()).toBe('reconnecting');
    expect(viewer().textContent).toContain(m.live_viewer_reconnecting());
    expect(viewer().textContent).not.toContain(m.live_viewer_full_title());
    timers.shift()!();
    await settle();
    expect(stateOf()).toBe('playing');
  });

  it('the end says so and offers the way back', async () => {
    await render();
    manifestErrors.push(refusal('ended', 410));
    timers.shift()!();
    await settle();
    expect(stateOf()).toBe('ended');
    expect(viewer().textContent).toContain(m.live_viewer_ended_title());
    expect(document.querySelector('[data-live-back]')).not.toBeNull();
  });

  it('a cut live gets its own screen, with the way back, and not the plain end', async () => {
    await render();
    manifestErrors.push(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut')
    );
    timers.shift()!();
    await settle();
    expect(stateOf()).toBe('ended');
    expect(viewer().textContent).toContain(m.live_viewer_cut_title());
    expect(viewer().textContent).not.toContain(m.live_viewer_ended_title());
    expect(document.querySelector('[data-live-back]')).not.toBeNull();
  });

  it.each([
    ['not-found', 404],
    ['removed', 403],
    ['disabled', 404],
  ] as const)('%s is the neutral "indisponible" screen', async (kind, status) => {
    liveErrors.push(refusal(kind, status));
    const { onClose } = await render();
    expect(stateOf()).toBe('unavailable');
    expect(viewer().textContent).toContain(m.live_viewer_unavailable_title());
    document.querySelector<HTMLButtonElement>('[data-live-back]')!.click();
    expect(onClose).toHaveBeenCalled();
  });

  it("the sound toggle sets the app's one sound answer", async () => {
    await render();
    const button = document.querySelector<HTMLButtonElement>('[data-live-sound]')!;
    expect(button.getAttribute('aria-label')).toBe(m.live_viewer_unmute());
    button.click();
    flushSync();
    expect(videoSound.muted).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(m.live_viewer_mute());
    expect(document.querySelector<HTMLVideoElement>('[data-live-video]')!.muted).toBe(false);
  });

  it('Escape closes it and the seat goes back', async () => {
    const { onClose } = await render();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
    unmount(mounted.pop()!);
    expect(deps.leaveSeat).toHaveBeenCalledWith(LIVE.id);
  });
});
