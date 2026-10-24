// @vitest-environment happy-dom
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
import type { LiveChatDeps } from '$lib/live/liveChat';
import type { LiveLimits, LiveListItem, LiveManifest } from '$lib/live/types';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { setContentModerator } from '$lib/stores/userState.svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => '',
  resolveUserDisplayName: async () => 'Ada',
}));
vi.mock('$lib/associations/api', () => ({
  getAssociation: vi.fn(),
  ensureContentModerator: vi.fn(async () => false),
}));
vi.mock('$lib/stores/userState.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/userState.svelte')>()),
  currentUserId: () => 'a'.repeat(64),
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const LIMITS = { chatMessageMaxChars: 300, reactionTapsPerWindow: 10 } as LiveLimits;

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
/** What the next manifest answers as its viewer count. */
let viewerCount: number | null;
let deps: Partial<LivePlayerDeps>;
let chatDeps: Partial<LiveChatDeps>;
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  timers = [];
  liveErrors = [];
  manifestErrors = [];
  viewerCount = 1;
  videoSound.setMuted(true);
  chatDeps = {
    postMessage: vi.fn(),
    postReactions: vi.fn(async (_l: string, burstId: string) => ({ burstId, seq: 1 })),
    hideMessage: vi.fn(),
    seal: vi.fn(async (_k, _l, _c, _a, text: string) => `S:${text}`),
    open: vi.fn(async (_k, _l, _c, _a, sealed: string) => sealed.slice(2)),
    newId: () => '00000000-0000-4000-8000-000000000001',
  };
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
        viewers: viewerCount,
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
  setContentModerator(false);
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
  mounted.push(
    mount(LiveViewer, {
      target,
      props: {
        live: LIVE,
        onClose,
        deps,
        chatDeps,
        fetchLimits: async () => LIMITS,
        probeModerator: async () => false,
      },
    })
  );
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

  it('shows HOW MANY watch - an eye and the number, the plural for a screen reader - and follows each poll', async () => {
    await render();
    const count = () => document.querySelector<HTMLElement>('[data-live-viewer-count]');
    expect(count()?.getAttribute('data-live-viewer-count')).toBe('1');
    expect(count()?.querySelector('svg')).not.toBeNull();
    expect(count()?.textContent).toContain(m.live_viewer_count({ count: 1 }));
    expect(count()?.getAttribute('aria-live')).toBe('off');
    viewerCount = 7;
    timers.shift()!();
    await settle();
    expect(count()?.getAttribute('data-live-viewer-count')).toBe('7');
    expect(count()?.textContent).toContain(m.live_viewer_count({ count: 7 }));
    // No count to show: nothing drawn, never a stale or guessed number.
    viewerCount = null;
    timers.shift()!();
    await settle();
    expect(count()).toBeNull();
  });

  it('a failed poll (reconnecting) takes the count off the screen, and the next answer brings it back', async () => {
    await render();
    expect(document.querySelector('[data-live-viewer-count]')).not.toBeNull();
    manifestErrors.push(refusal('seats-unavailable', 503));
    timers.shift()!();
    await settle();
    expect(stateOf()).toBe('reconnecting');
    expect(document.querySelector('[data-live-viewer-count]')).toBeNull();
    viewerCount = 3;
    timers.shift()!();
    await settle();
    expect(
      document.querySelector('[data-live-viewer-count]')?.getAttribute('data-live-viewer-count')
    ).toBe('3');
  });

  it('draws no count on the end screen', async () => {
    await render();
    expect(document.querySelector('[data-live-viewer-count]')).not.toBeNull();
    manifestErrors.push(refusal('ended', 410));
    timers.shift()!();
    await settle();
    expect(document.querySelector('[data-live-viewer-count]')).toBeNull();
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

  it('carries the report flag in the top bar, outside the video and the status layer', async () => {
    await render();
    const flag = document.querySelector<HTMLElement>('[data-live-report]')!;
    expect(flag.getAttribute('aria-label')).toBe(m.live_report_button());
    expect(flag.closest('[data-live-video]')).toBeNull();
    expect(flag.closest('[role="status"]')).toBeNull();
    expect(viewer().contains(flag)).toBe(true);
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

  it('the chat rides the manifest poll: a line drawn, a tap sent as one burst at the next tick, gone on the end', async () => {
    const plain = deps.fetchManifest!;
    deps.fetchManifest = vi.fn(async (...args: Parameters<typeof plain>) => {
      const manifest: LiveManifest = await plain(...args);
      const first = args[2]?.messagesAfter === undefined;
      return {
        ...manifest,
        chat: {
          messages: first
            ? [
                {
                  id: 'm-1',
                  seq: 1,
                  authorId: 'b'.repeat(64),
                  clientId: '33333333-3333-4333-8333-333333333333',
                  sealed: 'S:bonjour',
                  createdAt: '2026-10-19T10:01:00.000Z',
                },
              ]
            : [],
          messagesCursor: 1,
          reactions: [],
          reactionsCursor: 0,
        },
      };
    });
    await render();
    expect(vi.mocked(deps.fetchManifest).mock.calls[0][2]).toEqual({
      messagesAfter: undefined,
      reactionsAfter: undefined,
    });
    expect(document.querySelector('[data-live-chat-line="m-1"]')?.textContent).toContain('bonjour');
    expect(document.querySelector('[data-live-chat-composer]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-live-reaction="canari"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-live-reaction="canari"]')!.click();
    expect(chatDeps.postReactions).not.toHaveBeenCalled();
    timers.shift()!();
    await settle();
    expect(chatDeps.postReactions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatDeps.postReactions!).mock.calls[0][2]).toEqual({ canari: 2 });
    expect(vi.mocked(deps.fetchManifest).mock.calls.at(-1)![2]).toEqual({
      messagesAfter: 1,
      reactionsAfter: 0,
    });

    manifestErrors.push(refusal('ended', 410));
    timers.shift()!();
    await settle();
    expect(document.querySelector('[data-live-chat]')).toBeNull();
  });

  it('the chat toggle hides the lines and keeps the reactions', async () => {
    await render();
    const toggle = document.querySelector<HTMLButtonElement>('[data-live-chat-toggle]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    flushSync();
    expect(document.querySelector('[data-live-chat]')).toBeNull();
    expect(document.querySelector('[data-live-reactions]')).not.toBeNull();
  });

  /** Every manifest carries one line from another member. */
  function withOneLine() {
    const plain = deps.fetchManifest!;
    deps.fetchManifest = vi.fn(async (...args: Parameters<typeof plain>) => ({
      ...(await plain(...args)),
      chat: {
        messages: [
          {
            id: 'm-1',
            seq: 1,
            authorId: 'b'.repeat(64),
            clientId: '33333333-3333-4333-8333-333333333333',
            sealed: 'S:bonjour',
            createdAt: '2026-10-19T10:01:00.000Z',
          },
        ],
        messagesCursor: 1,
        reactions: [],
        reactionsCursor: 0,
      },
    }));
  }

  it("a chat write answered 410 shows the player's end screen, not a failed line", async () => {
    chatDeps.postReactions = vi.fn(async () => {
      throw refusal('ended', 410);
    });
    await render();
    expect(stateOf()).toBe('playing');
    document.querySelector<HTMLButtonElement>('[data-live-reaction="canari"]')!.click();
    timers.shift()!();
    await settle();
    expect(chatDeps.postReactions).toHaveBeenCalledTimes(1);
    expect(stateOf()).toBe('ended');
    expect(document.body.textContent).toContain(m.live_viewer_ended_title());
    expect(document.querySelector('[data-live-chat]')).toBeNull();
  });

  it("a chat write answered 410 with endReason 'cut' shows the cut screen, as the player's own poll would", async () => {
    chatDeps.postReactions = vi.fn(async () => {
      throw new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut');
    });
    await render();
    document.querySelector<HTMLButtonElement>('[data-live-reaction="canari"]')!.click();
    timers.shift()!();
    await settle();
    expect(stateOf()).toBe('ended');
    expect(document.body.textContent).toContain(m.live_viewer_cut_title());
    expect(document.body.textContent).not.toContain(m.live_viewer_ended_title());
  });

  it('a chat write refused for that write alone (429) leaves the live playing', async () => {
    chatDeps.postReactions = vi.fn(async () => {
      throw refusal('rate-limited', 429);
    });
    await render();
    document.querySelector<HTMLButtonElement>('[data-live-reaction="canari"]')!.click();
    timers.shift()!();
    await settle();
    expect(chatDeps.postReactions).toHaveBeenCalledTimes(1);
    expect(stateOf()).toBe('playing');
  });

  it('the hide button is for staff only: a content moderator sees it, a viewer does not', async () => {
    withOneLine();
    chatDeps.hideMessage = vi.fn(async (liveId: string, messageId: string) => ({
      liveId,
      messageId,
      hidden: true as const,
    }));
    await render();
    expect(document.querySelector('[data-live-chat-line="m-1"]')).not.toBeNull();
    expect(document.querySelector('[data-live-chat-hide]')).toBeNull();
    setContentModerator(true);
    flushSync();
    document
      .querySelector<HTMLButtonElement>('[data-live-chat-line="m-1"] [data-live-chat-hide]')!
      .click();
    await settle();
    expect(chatDeps.hideMessage).toHaveBeenCalledWith(LIVE.id, 'm-1');
  });
});
