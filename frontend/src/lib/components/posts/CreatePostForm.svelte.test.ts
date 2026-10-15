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
import { holdPostComposerMedia } from '$lib/posts/postComposerDraft';

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

// The media strip and the draft banner leave by an outro.
afterAll(adoptTransitionAnimations());

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.setItem('canari_saved_user', 'user-a');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:pick', revokeObjectURL: () => {} })
  );
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  holdPostComposerMedia([]);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CreatePostForm, { target, props: { onPostCreated: vi.fn() } });
  mounted.push(app);
  flushSync();
  await tick();
  return { target, app };
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

  it('another account never opens the first one media', async () => {
    const first = await open();
    pick(first.target, new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    unmount(mounted.pop()!);

    localStorage.setItem('canari_saved_user', 'user-b');
    const second = await open();
    expect(second.target.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });
});
