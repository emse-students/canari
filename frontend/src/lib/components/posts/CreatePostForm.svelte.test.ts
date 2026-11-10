// @vitest-environment happy-dom
/**
 * Closing the new-post composer keeps what it holds - its text as a stored draft, and since the Mi
 * 9T reading of v1.2.9-alpha.1 its MEDIA too, in memory: Back closed the composer holding a video
 * just filmed, with no question, and the video was gone at the next open. Text is not asked about,
 * so media are not either - both are kept.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CreatePostForm from './CreatePostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import {
  ANONYMOUS_POST_IDENTITY,
  forgetPostComposerMedia,
  heldPostComposerMedia,
  holdPostComposerMedia,
  emptyPostComposerDraft,
  loadPostComposerDraft,
  savePostComposerDraft,
} from '$lib/posts/postComposerDraft';
import { cameraOverlayStub } from '../reels/cameraOverlayStub.test-helper';

const toast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/toast.svelte')>()),
  showToast: toast,
}));
vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => Promise.resolve() }));
vi.mock('$lib/forms/api', () => ({ getForms: () => Promise.resolve([]) }));
// The composer hands the post to the background publish queue; what it hands over is the assertion.
const enqueuePost = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock('$lib/posts/publishQueue/publishQueue.svelte', () => ({ enqueuePost }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
  listLiveAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost: vi.fn(),
  getReelLimits: () =>
    Promise.resolve({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      maxAspectRatio: 0.8,
      retentionDays: 365,
      warningWindowDays: 7,
    }),
}));
// What the engine reads of a picked video (its displayed frame and length): set per test.
const pickedVideo = vi.hoisted(() => ({
  metadata: { durationMs: null, width: null, height: null } as {
    durationMs: number | null;
    width: number | null;
    height: number | null;
  },
}));
vi.mock('$lib/reels/videoDuration', () => ({
  readVideoMetadata: () => Promise.resolve(pickedVideo.metadata),
}));

vi.mock('$lib/components/reels/CameraOverlay.svelte', async () => ({
  default: (await import('../reels/CameraOverlayStub.test-helper.svelte')).default,
}));

// The media strip and the draft banner leave by an outro.
afterAll(adoptTransitionAnimations());

const mounted: Record<string, unknown>[] = [];
const revoked: string[] = [];

beforeEach(() => {
  localStorage.setItem('canari_saved_user', 'user-a');
  setCurrentUserId('user-a');
  enqueuePost.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => 'blob:pick',
      revokeObjectURL: (url: string) => revoked.push(url),
    })
  );
});

afterEach(() => {
  pickedVideo.metadata = { durationMs: null, width: null, height: null };
  while (mounted.length) unmount(mounted.pop()!);
  holdPostComposerMedia([]);
  revoked.length = 0;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onPostCreated = vi.fn();
  const app = mount(CreatePostForm, { target, props: { onPostCreated, onGoLive: vi.fn() } });
  mounted.push(app);
  flushSync();
  await tick();
  return { target, app, onPostCreated };
}

function pick(target: HTMLElement, file: File) {
  const input = target.querySelector<HTMLInputElement>('input[accept="image/*,video/*"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

describe('CreatePostForm - closing keeps the media', () => {
  it('a video attached, the composer closed and reopened: the video is still there, and the banner says so', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    expect(first.target.querySelectorAll('[role="listitem"]')).toHaveLength(1);

    // Back closes the composer: the modal unmounts it.
    unmount(mounted.pop()!);

    const second = await open();
    expect(second.target.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(second.target.textContent).toContain(m.post_create_draft_restored_detail_with_media());
  });

  it('"Effacer" on the restored draft lets the media go with the text', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    unmount(mounted.pop()!);

    const second = await open();
    const clear = [...second.target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.post_create_clear_draft_label()
    )!;
    clear.click();
    flushSync();
    // The strip leaves by an outro; what matters is that nothing is held for the next open.
    unmount(mounted.pop()!);

    const third = await open();
    expect(third.target.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('a close gives back the previews it made: the held FILE stays, its object URL does not', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    expect(revoked).toEqual([]);
    unmount(mounted.pop()!);
    expect(revoked).toEqual(['blob:pick']);
    expect(heldPostComposerMedia()).toHaveLength(1);
  });

  it('a sign-out drops the held media from memory', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    unmount(mounted.pop()!);
    forgetPostComposerMedia();
    expect(heldPostComposerMedia()).toEqual([]);
    const second = await open();
    expect(second.target.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('another account never opens the first one media', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    unmount(mounted.pop()!);

    localStorage.setItem('canari_saved_user', 'user-b');
    const second = await open();
    expect(second.target.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });
});

describe('CreatePostForm - the strip of picked files', () => {
  it('trims a held draft over the cap to ten at restore, through the same rule as a pick', async () => {
    // Twelve can only arrive from a composer closed before the cap existed: it goes through
    // `admitAttachments` like every other way in, and the reader is told.
    holdPostComposerMedia(
      Array.from({ length: 12 }, (_, i) => new File(['x'], `p${i}`, { type: 'image/png' }))
    );
    const { target } = await open();
    expect(target.querySelectorAll('[role="listitem"]')).toHaveLength(10);
    expect(toast).toHaveBeenCalledWith(
      m.post_attachments_partial({ taken: 10, leftOut: 2, max: 10 })
    );
  });
});

describe('CreatePostForm - a video filmed with its camera is a CanaReel (one camera, one behaviour, 2026-10-19)', () => {
  it('hands its text to the camera as the caption, and once the reel is published the text is spent and the composer closes', async () => {
    savePostComposerDraft(emptyPostComposerDraft('a caption written first'));
    const { target, onPostCreated } = await open();
    await tick();

    target.querySelector<HTMLButtonElement>('button[data-post-camera]')!.click();
    flushSync();
    expect(cameraOverlayStub.last).toEqual({
      destination: 'post',
      composerStart: { caption: 'a caption written first', identity: '', studentsOnly: false },
    });

    document.querySelector<HTMLButtonElement>('[data-camera-overlay-stub-publish]')!.click();
    flushSync();

    expect(onPostCreated).toHaveBeenCalledTimes(1);
    // The text became the reel's caption: the next open must not offer it again.
    expect(loadPostComposerDraft()).toBeNull();
  });

  /** Opens the composer on `draft`, then its camera (the stub records what it was handed). */
  async function openCamera(draft = emptyPostComposerDraft('text')) {
    savePostComposerDraft(draft);
    const opened = await open();
    await tick();
    opened.target.querySelector<HTMLButtonElement>('button[data-post-camera]')!.click();
    flushSync();
    return opened;
  }

  it.each([
    ['a poll', { includePoll: true, pollQuestion: 'Q?' }],
    ['a schedule', { scheduledAt: '2030-01-01T10:00' }],
    ['a form', { includeForm: true, selectedFormId: 'form-1' }],
  ])(
    'with %s set, the camera attaches its video to the post as before (`post-edit`)',
    async (_, set) => {
      await openCamera({ ...emptyPostComposerDraft('text'), ...set });
      expect(cameraOverlayStub.last?.destination).toBe('post-edit');
    }
  );

  it("the composer's identity is the camera's: an association chosen here is the reel's start", async () => {
    await openCamera({ ...emptyPostComposerDraft('text'), selectedAssociationId: 'asso-1' });
    expect(cameraOverlayStub.last?.composerStart?.identity).toBe('asso-1');
  });

  it('an ANONYMOUS reel lands in the personal feed, never in the associations one', async () => {
    const { onPostCreated } = await openCamera({
      ...emptyPostComposerDraft('text'),
      selectedAssociationId: ANONYMOUS_POST_IDENTITY,
    });
    document.querySelector<HTMLButtonElement>('[data-camera-overlay-stub-publish]')!.click();
    flushSync();
    expect(onPostCreated).toHaveBeenCalledWith('all');
  });

  it('the media already attached stay as the draft after the reel is published', async () => {
    const { target } = await openCamera();
    // The camera stub is up; close it by publishing after a photo was picked first.
    unmount(mounted.pop()!);
    const second = await open();
    pick(second.target, new File(['x'], 'IMG_1.png', { type: 'image/png' }));
    second.target.querySelector<HTMLButtonElement>('button[data-post-camera]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-camera-overlay-stub-publish]')!.click();
    flushSync();
    expect(heldPostComposerMedia()).toHaveLength(1);
    expect(target.isConnected).toBe(true);
  });
});

describe('CreatePostForm - a picked vertical short video is said to be a CanaReel BEFORE "Publier" (2026-11-09)', () => {
  const notice = (target: HTMLElement) =>
    target.querySelector('[data-post-composer-reel-notice]')?.textContent?.trim() ?? null;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await tick();
    flushSync();
  };

  it('a vertical video of 90 s or less: the notice names the rule and the lifetime', async () => {
    pickedVideo.metadata = { durationMs: 30_000, width: 1080, height: 1920 };
    const { target } = await open();
    pick(target, new File(['take'], 'clip.mp4', { type: 'video/mp4' }));
    await settle();
    expect(notice(target)).toBe(
      m.reels_publish_from_composer_notice({
        seconds: 90,
        lifetime: m.reels_lifetime_years({ count: 1 }),
      })
    );
  });

  it('a landscape video, a longer one or an unreadable one stays a post: no notice', async () => {
    for (const metadata of [
      { durationMs: 30_000, width: 1920, height: 1080 },
      { durationMs: 90_001, width: 1080, height: 1920 },
      { durationMs: null, width: null, height: null },
    ]) {
      pickedVideo.metadata = metadata;
      const { target } = await open();
      pick(target, new File(['take'], 'clip.mp4', { type: 'video/mp4' }));
      await settle();
      expect(notice(target)).toBeNull();
      unmount(mounted.pop()!);
      holdPostComposerMedia([]);
    }
  });
});

describe('CreatePostForm - where a post lands', () => {
  it('an ANONYMOUS post lands in the personal feed, never in the associations one', async () => {
    savePostComposerDraft({
      ...emptyPostComposerDraft('said anonymously'),
      selectedAssociationId: ANONYMOUS_POST_IDENTITY,
    });
    const { target, onPostCreated } = await open();
    await tick();
    const publish = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === m.post_create_publish_button_label()
    )!;
    publish.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(onPostCreated).toHaveBeenCalledWith('all');
  });
});

describe('CreatePostForm - a published post takes its media with it', () => {
  it('the media handed to the publish queue are not offered again at the next open', async () => {
    const first = await open();
    // The parent unmounts the composer the moment it is told the post is created, before any
    // effect of the composer flushes again.
    first.onPostCreated.mockImplementation(() => unmount(mounted.pop()!));
    pick(first.target, new File(['photo'], 'p.jpg', { type: 'image/jpeg' }));
    const publish = [...first.target.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === m.post_create_publish_button_label()
    )!;
    publish.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(enqueuePost).toHaveBeenCalledTimes(1);
    expect(first.onPostCreated).toHaveBeenCalledTimes(1);
    expect(heldPostComposerMedia()).toEqual([]);
  });
});
