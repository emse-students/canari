// @vitest-environment happy-dom
/**
 * "Envoyer a..." on the camera tab (RC-12, 15.1): behind the chat writer switch the review of a
 * VIDEO offers the send sheet instead of "Suivant"; CanaReels alone is today's publish step; chats
 * alone write ONE take through the messaging host and free the camera; both write the take first,
 * WAITING for the publish step's upload, and that step hands its upload over before the post exists.
 * Switch off, nothing here exists.
 */
import { stubCameraCount } from '../../../test/cameraDevices';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelCapture from './ReelCapture.svelte';
import { SHUTTER_HOLD_THRESHOLD_MS } from '$lib/reels/reelCapture';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { installFakeMediaRecorder } from '$lib/reels/fakeMediaRecorder.test-helper';
import { registerReelSendHost, type ReelSendHost } from '$lib/reels/reelSendBridge';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import type { PublishReelDeps } from '$lib/reels/publishReel';
import type { Conversation } from '$lib/types';
import { toastStore } from '$lib/stores/toast.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { giveMediaStreamGetTracks } from '$lib/reels/mediaStreamTracks.test-helper';

giveMediaStreamGetTracks();
afterAll(adoptTransitionAnimations());

const writer = vi.hoisted(() => ({ on: true }));
vi.mock('$lib/reels/chatReelWriter', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/chatReelWriter')>()),
  chatReelAllowed: () => writer.on,
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(async () => true) }));
const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
vi.mock('$app/navigation', () => ({
  afterNavigate: () => {},
  beforeNavigate: () => {},
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({ navigating: { to: null } }));
vi.mock('$lib/utils/appVersion', () => ({
  isIosTauriRuntime: () => false,
  isAndroidTauriRuntime: () => false,
  isMobileTauriRuntime: () => false,
}));
vi.mock('$lib/reels/videoDuration', () => ({ readVideoDurationMs: () => Promise.resolve(5_000) }));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/moderation/muteCheck', () => ({
  cachedMuteStatus: () => null,
  getMuteStatus: async () => ({ isMuted: false, mutedReason: null }),
}));
vi.mock('$lib/users/blocks', () => ({ listBlockedUsers: async () => [] }));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: async () => null,
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('./AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./VideoPlayerStub.test-helper.svelte')).default,
}));

const framed = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(),
  photo: vi.fn(),
  thumbnail: vi.fn(),
}));
vi.mock('$lib/reels/framedCapture', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/framedCapture')>()),
  takeFramedPhoto: framed.photo,
  takeFramedThumbnail: framed.thumbnail,
  FramedStream: { start: framed.start },
}));

const mounted: Record<string, unknown>[] = [];

function stream(): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => ({}) };
  const audio = [{ stop: vi.fn(), kind: 'audio' }];
  const s = {
    getTracks: () => [track, ...audio],
    getVideoTracks: () => [track],
    getAudioTracks: () => audio,
  };
  Object.setPrototypeOf(s, MediaStream.prototype);
  return s as unknown as MediaStream;
}

function group(id: string, name: string, at: number): [string, Conversation] {
  return [
    id,
    {
      id,
      name,
      contactName: name,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: 'group',
      lastMessageAt: at,
    } as unknown as Conversation,
  ];
}

const host = {
  conversations: () => [group('g-1', 'Alpha', 9), group('g-2', 'Beta', 5)],
  userId: () => '11111111-1111-4111-8111-111111111111',
  send: vi.fn(async (_f: File, keys: readonly string[], _opts?: object) => ({
    takeId: 't-1',
    queued: keys.length,
  })),
  adopt: vi.fn(async () => {}),
  endWait: vi.fn(),
} satisfies ReelSendHost;

function publishDeps(): PublishReelDeps {
  return {
    assertNotMuted: vi.fn(async () => {}),
    getToken: vi.fn(async () => 'tok'),
    uploadLimits: vi.fn(async () => ({ maxPlaintextBytes: 1000 })),
    prepare: vi.fn(async () => ({
      file: new File([new Uint8Array(4)], 'reel.mp4', { type: 'video/mp4' }),
      width: 720,
      height: 1280,
      durationSeconds: 3,
      sourceBytes: 8,
      outputBytes: 4,
    })),
    placeholder: vi.fn(async () => null),
    upload: vi.fn(async () => ({
      type: 'video' as const,
      mediaId: 'm-1',
      key: 'k',
      iv: 'i',
      mimeType: 'video/mp4',
      size: 4,
    })),
    createPost: vi.fn(async () => ({ id: 'p-1' }) as never),
  };
}

let unstubCameras = () => {};
let unregister = () => {};
beforeEach(() => {
  writer.on = true;
  unstubCameras = stubCameraCount(2);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  framed.photo.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }));
  framed.start.mockReturnValue({ stream: stream(), bitrate: 3_000_000, stop: framed.stop });
  installFakeMediaRecorder();
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
  getReelLimits.mockResolvedValue({
    maxDurationMs: 90_000,
    chatMaxDurationMs: 60_000,
    chatReelMaxTargets: 15,
    retentionDays: 30,
    warningWindowDays: 7,
  });
  unregister = registerReelSendHost(host);
});

afterEach(() => {
  unregister();
  unstubCameras();
  vi.useRealTimers();
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(extra: Record<string, unknown> = {}) {
  const session = new CameraSession(() => Promise.resolve(stream()));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ReelCapture, { target, props: { session, ...extra } }));
  await settle();
  const video = target.querySelector('video')!;
  Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
  video.dispatchEvent(new Event('loadeddata'));
  await settle();
  const shutter = () => target.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
  const pointer = (type: string, timeStamp: number) => {
    const event = new PointerEvent(type, { pointerId: 1, bubbles: true });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    shutter().dispatchEvent(event);
  };
  const hold = async () => {
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    pointer('pointerup', 4000);
    await settle();
  };
  const tap = async () => {
    pointer('pointerdown', 1000);
    pointer('pointerup', 1100);
    await settle();
  };
  return { target, hold, tap };
}

const click = async (target: HTMLElement, selector: string) => {
  target.querySelector<HTMLButtonElement>(selector)!.click();
  await settle();
};
const toasts = () => toastStore.toasts.map((t) => t.message);

describe('"Envoyer a..." on the camera tab (RC-12)', () => {
  it('SWITCH OFF: the review says "Suivant", opens the publish step, and no sheet exists', async () => {
    writer.on = false;
    const { target, hold } = await render();
    await hold();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reels_review_next());
    await click(target, '[data-reel-next]');
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(host.send).not.toHaveBeenCalled();
  });

  it('the server serving no target count offers no multi-send: "Suivant" stays', async () => {
    getReelLimits.mockResolvedValue({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      retentionDays: 30,
      warningWindowDays: 7,
    });
    const { target, hold } = await render();
    await hold();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reels_review_next());
  });

  it('a PHOTO keeps "Suivant": its chat send is not built', async () => {
    const { target, tap } = await render();
    await tap();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reels_review_next());
  });

  it('SWITCH ON: a video review offers "Envoyer a...", which opens the sheet, and Back returns to the take', async () => {
    const { target, hold } = await render();
    await hold();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reel_sendto_action());
    await click(target, '[data-reel-next]');
    expect(target.querySelector('[data-reel-send]')).not.toBeNull();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    await click(target, '[data-reel-send] header button');
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('with no messaging layer (no session) it says so and keeps the review', async () => {
    unregister();
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    expect(toasts()).toContain(m.reel_sendto_sheet_unavailable());
  });

  it("CanaReels alone is today's path: the publish step opens and nothing is queued", async () => {
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-submit]');
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(host.send).not.toHaveBeenCalled();
  });

  it('conversations alone write ONE take for every target and free the camera at once', async () => {
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-row="g-2"]');
    await click(target, '[data-reel-send-submit]');

    expect(host.send).toHaveBeenCalledTimes(1);
    const [file, keys, opts] = host.send.mock.calls[0] as unknown as [File, string[], object];
    expect(file.type.startsWith('video/')).toBe(true);
    expect(keys).toEqual(['g-1', 'g-2']);
    expect(opts).toEqual({ takeId: undefined, awaitsPublish: false });
    expect(toasts()).toContain(m.reel_sendto_sending({ count: 2 }));
    // The take is over: the review and the sheet are gone, the preview is back.
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-reel-shutter]')).not.toBeNull();
  });

  it('a send the host refuses (null) says so and keeps the sheet: nothing was written', async () => {
    host.send.mockResolvedValueOnce(null as never);
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');
    expect(toasts()).toContain(m.reel_sendto_failed());
    expect(target.querySelector('[data-reel-send]')).not.toBeNull();
  });

  it('CanaReels AND conversations: the take is written first, waiting for the publish step, whose upload it adopts BEFORE the post exists', async () => {
    const deps = publishDeps();
    const order: string[] = [];
    host.adopt.mockImplementation(async () => {
      order.push('adopt');
    });
    deps.createPost = vi.fn(async () => {
      order.push('createPost');
      return { id: 'p-1' } as never;
    });
    const { target, hold } = await render({ publishDeps: deps });
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');

    expect(host.send.mock.calls[0][2]).toEqual({ takeId: expect.any(String), awaitsPublish: true });
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();

    await click(target, '[data-reel-publish-submit]');
    expect(host.adopt).toHaveBeenCalledTimes(1);
    expect(host.adopt.mock.calls[0]).toEqual([
      't-1',
      expect.objectContaining({ durationMs: 3000 }),
    ]);
    expect(order).toEqual(['adopt', 'createPost']);
    // The publish ended: the take stops waiting for it.
    expect(host.endWait).toHaveBeenCalledWith('t-1');
  });

  it('Back from the publish step AFTER the sends were queued ends the take: the sends are never withdrawn, nothing can be sent twice', async () => {
    const deps = publishDeps();
    const { target, hold } = await render({ publishDeps: deps });
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');
    await click(target, '[data-reel-publish] header button');

    expect(target.querySelector('[data-reel-publish]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(host.endWait).toHaveBeenCalledWith('t-1');
    expect(deps.upload).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(1);
  });

  it('the system Back on the sheet returns to the review', async () => {
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    vi.mocked(pushHistoryOverlay).mock.calls.at(-1)![0]('back');
    await settle();
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });
});
