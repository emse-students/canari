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
import { dismissToast, toastStore } from '$lib/stores/toast.svelte';
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
  listLiveAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/moderation/muteCheck', () => ({
  MutedError: class MutedError extends Error {},
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
  sendImage: vi.fn(
    async (_f: File, keys: readonly string[]): Promise<number | null> => keys.length
  ),
  adopt: vi.fn(async () => {}),
  endWait: vi.fn(),
  groupMembers: vi.fn(async () => new Map<string, string[]>()),
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
  // Each test reads ITS toasts: one left by an earlier test would satisfy, or break, its assertions.
  // A copy: each dismissal removes from the list being walked.
  for (const t of toastStore.toasts.slice()) dismissToast(t.id);
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

  it('SWITCH OFF: a PHOTO keeps the one "Suivant", as in production', async () => {
    writer.on = false;
    const { target, tap } = await render();
    await tap();
    expect(target.querySelector('[data-reel-secondary]')).toBeNull();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reels_review_next());
  });

  it('D-photo: a PHOTO gets the same review - "Publier" and "Envoyer a..."', async () => {
    const { target, tap } = await render();
    await tap();
    expect(target.querySelector('[data-reel-secondary]')!.textContent?.trim()).toBe(
      m.reel_review_publish()
    );
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reel_sendto_action());
  });

  it('D-photo: a PHOTO sent to conversations goes as ordinary image messages, never a reel take, and frees the camera', async () => {
    const { target, tap } = await render();
    await tap();
    await click(target, '[data-reel-next]');
    expect(target.querySelector('[data-reel-send-same-as-post]')).toBeNull();
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-row="g-2"]');
    await click(target, '[data-reel-send-submit]');
    expect(host.send).not.toHaveBeenCalled();
    expect(host.sendImage).toHaveBeenCalledTimes(1);
    const [file, keys] = host.sendImage.mock.calls[0] as unknown as [File, string[]];
    expect(file.type).toMatch(/^image\//);
    expect(keys).toEqual(['g-1', 'g-2']);
    expect(toasts()).toContain(m.reel_sendto_sending({ count: 2 }));
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-reel-shutter]')).not.toBeNull();
  });

  it('D-photo: "Publier" AND a conversation sends the image, then opens the publish step; its Back ends the take', async () => {
    const { target, tap } = await render({ publishDeps: publishDeps() });
    await tap();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-row="g-1"]');
    expect(target.querySelector('[data-reel-send-same-as-post]')).toBeNull();
    await click(target, '[data-reel-send-submit]');
    expect(host.sendImage).toHaveBeenCalledTimes(1);
    expect(host.send).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    await click(target, '[data-reel-publish] header button');
    expect(target.querySelector('[data-reel-review]')).toBeNull();
  });

  it('D-photo: a photo queued in only SOME conversations says how many it missed, and the take still ends', async () => {
    host.sendImage.mockResolvedValueOnce(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { target, tap } = await render();
    await tap();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-row="g-2"]');
    await click(target, '[data-reel-send-submit]');
    expect(toasts()).toContain(m.reel_sendto_photo_partial({ failed: 1, total: 2 }));
    expect(toasts()).not.toContain(m.reel_sendto_sending({ count: 1 }));
    // Already in the other conversation: a second press would send it there twice.
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    warn.mockRestore();
  });

  it('D-photo: a photo the host could not hand anywhere is said, and the sheet stays', async () => {
    host.sendImage.mockResolvedValueOnce(null);
    const { target, tap } = await render();
    await tap();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');
    expect(toasts()).toContain(m.reel_sendto_failed());
    expect(target.querySelector('[data-reel-send]')).not.toBeNull();
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

  /** A press of "both" whose write is still under way: the test settles it when it chooses. */
  async function pressBothHeld() {
    let settleSend: (v: { takeId: string; queued: number }) => void = () => {};
    host.send.mockImplementationOnce(
      () => new Promise((resolve) => (settleSend = resolve)) as never
    );
    const rendered = await render({ publishDeps: publishDeps() });
    await rendered.hold();
    await click(rendered.target, '[data-reel-next]');
    await click(rendered.target, '[data-reel-send-feed]');
    await click(rendered.target, '[data-reel-send-row="g-1"]');
    await click(rendered.target, '[data-reel-send-submit]');
    return { ...rendered, settleSend: () => settleSend({ takeId: 't-1', queued: 1 }) };
  }

  it('"Envoyer" is disabled while the write is under way, so one take is never queued twice', async () => {
    const { target, settleSend } = await pressBothHeld();
    expect(target.querySelector<HTMLButtonElement>('[data-reel-send-submit]')!.disabled).toBe(true);
    target.querySelector<HTMLButtonElement>('[data-reel-send-submit]')!.click();
    await settle();
    expect(host.send).toHaveBeenCalledTimes(1);
    settleSend();
    await settle();
  });

  it('Back on the sheet DURING the write: the publish step does not open, and the take stops waiting at once', async () => {
    const { target, settleSend } = await pressBothHeld();
    await click(target, '[data-reel-send] header button');
    settleSend();
    await settle();
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
    expect(host.endWait).toHaveBeenCalledWith('t-1');
  });

  it('the screen LEFT during the write: the take stops waiting at once', async () => {
    const { settleSend } = await pressBothHeld();
    unmount(mounted.pop()!);
    settleSend();
    await settle();
    expect(host.endWait).toHaveBeenCalledWith('t-1');
  });

  it('the screen left with the publish step open ends the wait', async () => {
    const { target, settleSend } = await pressBothHeld();
    settleSend();
    await settle();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    host.endWait.mockClear();
    unmount(mounted.pop()!);
    expect(host.endWait).toHaveBeenCalledWith('t-1');
  });

  it('a write that REJECTS is said, logged, keeps the sheet, and queues nothing twice', async () => {
    host.send.mockRejectedValueOnce(new Error('boom'));
    const { target, hold } = await render();
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');
    expect(toasts()).toContain(m.reel_sendto_failed());
    expect(target.querySelector('[data-reel-send]')).not.toBeNull();
    expect(target.querySelector<HTMLButtonElement>('[data-reel-send-submit]')!.disabled).toBe(
      false
    );
  });

  it('a publish that fails AFTER the adoption and is retried adopts the new upload and ends the wait each time', async () => {
    const deps = publishDeps();
    deps.createPost = vi
      .fn()
      .mockRejectedValueOnce(new Error('post refused'))
      .mockResolvedValueOnce({ id: 'p-1' } as never);
    const { target, hold } = await render({ publishDeps: deps });
    await hold();
    await click(target, '[data-reel-next]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-row="g-1"]');
    await click(target, '[data-reel-send-submit]');
    await click(target, '[data-reel-publish-submit]');
    expect(host.adopt).toHaveBeenCalledTimes(1);
    expect(host.endWait).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="alert"]')).not.toBeNull();
    await click(target, '[data-reel-publish-submit]');
    expect(host.adopt).toHaveBeenCalledTimes(2);
    expect((host.adopt.mock.calls as unknown[][])[1][0]).toBe('t-1');
    expect(deps.createPost).toHaveBeenCalledTimes(2);
    expect(host.endWait).toHaveBeenCalledTimes(2);
  });
});

describe('the two paths of "Envoyer a..." (owner, 2026-11-16, section 22)', () => {
  it('PATH 1, switch on: the review of a video holds "Publier" and "Envoyer a...", and "Publier" is the publish step, nothing queued', async () => {
    const { target, hold } = await render();
    await hold();
    const secondary = target.querySelector<HTMLButtonElement>('[data-reel-secondary]')!;
    expect(secondary.textContent?.trim()).toBe(m.reel_review_publish());
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reel_sendto_action());
    await click(target, '[data-reel-secondary]');
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(target.querySelector('[data-reel-send]')).toBeNull();
    expect(host.send).not.toHaveBeenCalled();
  });

  it('PATH 1, switch OFF: one "Suivant" and no second button, as in production', async () => {
    writer.on = false;
    const { target, hold } = await render();
    await hold();
    expect(target.querySelector('[data-reel-secondary]')).toBeNull();
    expect(target.querySelector('[data-reel-next]')!.textContent).toContain(m.reels_review_next());
  });

  it('PATH 1: the tab camera says no recipient', async () => {
    const { target } = await render();
    expect(target.querySelector('[data-camera-send-to]')).toBeNull();
  });

  const chatProps = (extra: Record<string, unknown> = {}) => ({
    destination: 'chat',
    chatFilms: true,
    chatTarget: { id: 'g-1', name: 'Alpha' },
    oncapture: vi.fn(),
    onclose: vi.fn(),
    ...extra,
  });

  it('PATH 2: the camera says "Envoyer a" and the conversation under it', async () => {
    const { target } = await render(chatProps());
    const header = target.querySelector('[data-camera-title]')!;
    expect(header.textContent).toContain(m.reel_camera_send_to());
    expect(header.textContent).toContain('Alpha');
  });

  it('PATH 2: the review holds "Ajouter des destinataires" and "Alpha" with the send arrow, and no publish button', async () => {
    const { target, hold } = await render(chatProps());
    await hold();
    const next = target.querySelector<HTMLButtonElement>('[data-reel-next]')!;
    expect(next.textContent?.trim()).toBe('Alpha');
    expect(next.getAttribute('aria-label')).toBe(m.reel_review_send_to_name({ name: 'Alpha' }));
    expect(target.querySelector('[data-reel-secondary]')!.textContent?.trim()).toBe(
      m.reel_review_add_recipients()
    );
    expect(target.textContent).not.toContain(m.reel_review_publish());
  });

  it('PATH 2: the name sends to the conversation in one tap - the take handed back as the direct "Envoyer" did, the camera closed', async () => {
    const props = chatProps();
    const { target, hold } = await render(props);
    await hold();
    await click(target, '[data-reel-next]');
    const file = props.oncapture.mock.calls[0][0] as File;
    expect(file.type).toMatch(/^video\//);
    expect(props.onclose).toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });

  it('PATH 2: "Ajouter des destinataires" opens the SAME sheet with the conversation ticked and "Publier" offered; the press queues ONE take and closes the camera', async () => {
    const props = chatProps();
    const { target, hold } = await render(props);
    await hold();
    await click(target, '[data-reel-secondary]');
    expect(target.querySelector('[data-reel-send]')).not.toBeNull();
    expect(target.querySelector('[data-reel-send-row="g-1"]')!.getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(target.querySelector('[data-reel-send-row="g-2"]')!.getAttribute('aria-checked')).toBe(
      'false'
    );
    expect(target.querySelector('[data-reel-send-feed]')!.textContent).toContain(
      m.reel_sendto_feed_row()
    );
    await click(target, '[data-reel-send-row="g-2"]');
    await click(target, '[data-reel-send-submit]');
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.send.mock.calls[0][1]).toEqual(['g-1', 'g-2']);
    expect(props.oncapture).not.toHaveBeenCalled();
    expect(props.onclose).toHaveBeenCalled();
  });

  it('PATH 2: "Publier" ticked with the conversation opens the publish step, which closes the camera instead of leaving for the feed', async () => {
    const props = chatProps({ publishDeps: publishDeps() });
    const { target, hold } = await render(props);
    await hold();
    await click(target, '[data-reel-secondary]');
    await click(target, '[data-reel-send-feed]');
    await click(target, '[data-reel-send-submit]');
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    await click(target, '[data-reel-publish-submit]');
    const { goto } = await import('$app/navigation');
    expect(goto).not.toHaveBeenCalled();
    expect(props.onclose).toHaveBeenCalled();
  });

  it('PATH 2 with no target count served: the one-tap send alone, no sheet offered', async () => {
    getReelLimits.mockResolvedValue({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      retentionDays: 30,
      warningWindowDays: 7,
    });
    const { target, hold } = await render(chatProps());
    await hold();
    expect(target.querySelector('[data-reel-secondary]')).toBeNull();
    expect(target.querySelector('[data-reel-next]')!.textContent?.trim()).toBe('Alpha');
  });

  it('PATH 2, switch OFF (a photo-only chat camera): no header, and a photo is "Ajouter" as in production', async () => {
    writer.on = false;
    const { target, tap } = await render(chatProps({ chatFilms: false }));
    expect(target.querySelector('[data-camera-send-to]')).toBeNull();
    await tap();
    expect(target.querySelector('[data-reel-secondary]')).toBeNull();
    expect(target.querySelector('[data-reel-next]')!.textContent?.trim()).toBe(
      m.reels_review_add()
    );
  });

  it('PATH 2: a PHOTO keeps its one "Ajouter" (a photo through the sheet is not built)', async () => {
    const { target, tap } = await render(chatProps());
    await tap();
    expect(target.querySelector('[data-reel-secondary]')).toBeNull();
    expect(target.querySelector('[data-reel-next]')!.textContent?.trim()).toBe(
      m.reels_review_add()
    );
  });
});
