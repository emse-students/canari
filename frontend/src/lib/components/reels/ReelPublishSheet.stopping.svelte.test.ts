// @vitest-environment happy-dom
/**
 * Which publishes a Back may still stop (re-review of #2124). A PHOTO from the camera tab has no
 * abort at any stage, so a Back from the moment "Publier" is pressed is refused - closing the step
 * used to return to the review while the post was still being created, and "Suivant", "Publier"
 * created a SECOND one. A VIDEO is stoppable until its upload: its re-encode signal is armed at the
 * press, so a Back during the mute check aborts it and no post is created.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelPublishSheet from './ReelPublishSheet.svelte';
import type { PublishReelDeps } from '$lib/reels/publishReel';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

/** The mute check, held open by the test: the publish waits in its first stage. */
const mute = vi.hoisted(() => ({ release: () => {}, check: vi.fn() }));
const createPost = vi.hoisted(() => vi.fn(async () => ({ id: 'p-1' })));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => mute.check() }));
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken: async () => 'tok',
}));
vi.mock('$lib/media', async (orig) => ({
  ...(await orig<typeof import('$lib/media')>()),
  preparePostMedia: async (file: File) => ({ file, dims: { width: 720, height: 1280 } }),
  MediaService: class {
    encryptAndUpload = async () => ({
      type: 'image',
      mediaId: 'm-1',
      key: 'k',
      iv: 'i',
      mimeType: 'image/jpeg',
      size: 3,
    });
    uploadLimits = async () => ({ maxPlaintextBytes: 1000 });
  },
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost,
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const mounted: Record<string, unknown>[] = [];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(blob: Blob, deps?: PublishReelDeps) {
  const onclose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelPublishSheet, {
      target,
      props: {
        clip: { blob, source: 'camera' },
        limits: { maxDurationMs: 90_000, retentionDays: 30, warningWindowDays: 7 },
        onclose,
        deps,
      },
    })
  );
  await settle();
  target.querySelector<HTMLButtonElement>('[data-reel-publish-submit]')!.click();
  await settle();
  return { target, onclose };
}

/** The step's own history entry, as a system Back or the edge swipe reaches it. */
const back = () => vi.mocked(pushHistoryOverlay).mock.calls.at(-1)![0]('back');

beforeEach(() => {
  mute.check.mockImplementation(() => new Promise<void>((r) => (mute.release = r)));
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ReelPublishSheet - a Back during a publish it cannot stop', () => {
  it('a PHOTO: a Back during the mute check is refused, and the post is created ONCE', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target, onclose } = await render(new Blob(['jpg'], { type: 'image/jpeg' }));

    back();
    await settle();
    expect(onclose).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();

    mute.release();
    await settle();
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('a VIDEO: a Back during the mute check stops it before any post exists', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const deps: PublishReelDeps = {
      assertNotMuted: () => mute.check(),
      getToken: async () => 'tok',
      uploadLimits: async () => ({ maxPlaintextBytes: 1000 }),
      // The real re-encode's first line: an aborted signal refuses before any work.
      prepare: vi.fn(async (_blob, options) => {
        if (options?.signal?.aborted) {
          const { VideoPrepareError } = await import('$lib/video/prepareVideoForUpload');
          throw new VideoPrepareError('aborted', 'aborted');
        }
        throw new Error('the re-encode ran although the publish was stopped');
      }),
      placeholder: vi.fn(async () => null),
      upload: vi.fn(),
      createPost: vi.fn(),
    };
    const { onclose } = await render(new Blob(['v'], { type: 'video/mp4' }), deps);

    back();
    await settle();
    expect(onclose).toHaveBeenCalledTimes(1);

    mute.release();
    await settle();
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.createPost).not.toHaveBeenCalled();
  });
});
