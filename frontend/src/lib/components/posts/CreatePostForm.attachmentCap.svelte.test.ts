// @vitest-environment happy-dom
/**
 * At most ten attachments a post (owner, 2026-11-02): a batch that would pass the cap takes as many
 * files as fit and says how many were left out; once full, nothing more is added.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CreatePostForm from './CreatePostForm.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import { holdPostComposerMedia } from '$lib/posts/postComposerDraft';

const toast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/toast.svelte')>()),
  showToast: toast,
}));
vi.mock('$lib/moderation/muteCheck', () => ({ assertNotMuted: () => Promise.resolve() }));
vi.mock('$lib/forms/api', () => ({ getForms: () => Promise.resolve([]) }));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listLinkableValidatedCalendarEvents: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  createPost: vi.fn(),
  getReelLimits: () =>
    Promise.resolve({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      retentionDays: 30,
      warningWindowDays: 7,
    }),
}));
vi.mock('$lib/components/reels/CameraOverlay.svelte', async () => ({
  default: (await import('../reels/CameraOverlayStub.test-helper.svelte')).default,
}));

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
  toast.mockReset();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(CreatePostForm, { target, props: { onPostCreated: vi.fn(), onGoLive: vi.fn() } })
  );
  flushSync();
  await tick();
  return target;
}

function pickDocuments(target: HTMLElement, count: number) {
  const input = target.querySelector<HTMLInputElement>('input[accept*=".pdf"]')!;
  const files = Array.from(
    { length: count },
    (_, i) => new File(['x'], `d${i}.pdf`, { type: 'application/pdf' })
  );
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

describe('CreatePostForm - the attachment cap', () => {
  it('takes as many as fit of a batch and says how many were left out', async () => {
    const target = await open();
    pickDocuments(target, 8);
    expect(toast).not.toHaveBeenCalled();
    pickDocuments(target, 4);
    expect(target.querySelectorAll('[role="listitem"]')).toHaveLength(10);
    expect(toast).toHaveBeenCalledWith(
      m.post_attachments_partial({ taken: 2, leftOut: 2, max: 10 })
    );
  });

  it('adds nothing once full, disables the chips, and says the post is full', async () => {
    const target = await open();
    pickDocuments(target, 10);
    expect(target.querySelector<HTMLInputElement>('input[accept*=".pdf"]')!.disabled).toBe(true);
    pickDocuments(target, 1);
    expect(target.querySelectorAll('[role="listitem"]')).toHaveLength(10);
    expect(toast).toHaveBeenCalledWith(m.post_attachments_full({ max: 10 }));
  });
});
