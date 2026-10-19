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
import {
  forgetPostComposerMedia,
  heldPostComposerMedia,
  holdPostComposerMedia,
  emptyPostComposerDraft,
  loadPostComposerDraft,
  savePostComposerDraft,
} from '$lib/posts/postComposerDraft';
import { cameraOverlayStub } from '../reels/cameraOverlayStub.test-helper';

vi.mock('$lib/forms/api', () => ({ getForms: () => Promise.resolve([]) }));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost: vi.fn(),
  getReelLimits: () =>
    Promise.resolve({ maxDurationMs: 90_000, retentionDays: 30, warningWindowDays: 7 }),
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
  const app = mount(CreatePostForm, { target, props: { onPostCreated } });
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
  it('draws "IMG_1" at index 1 and "IMG_" at index 11 as two tiles (their name+index keys collided)', async () => {
    const { target } = await open();
    for (let i = 0; i < 12; i++) {
      const name = i === 1 ? 'IMG_1' : i === 11 ? 'IMG_' : `p${i}`;
      pick(target, new File(['x'], name, { type: 'image/png' }));
    }
    expect(target.querySelectorAll('[role="listitem"]')).toHaveLength(12);
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
      composerCaption: 'a caption written first',
      composerIdentity: '',
    });

    document.querySelector<HTMLButtonElement>('[data-camera-overlay-stub-publish]')!.click();
    flushSync();

    expect(onPostCreated).toHaveBeenCalledTimes(1);
    // The text became the reel's caption: the next open must not offer it again.
    expect(loadPostComposerDraft()).toBeNull();
  });
});
