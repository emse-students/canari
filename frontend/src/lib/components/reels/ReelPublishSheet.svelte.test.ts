/**
 * The publish step as the member meets it: "Publier" creates the reel and lands on the feed, a
 * refused publish says why and stays, a cancelled re-encode says nothing, and the back arrow returns
 * to the take. The services are injected (`deps`); nothing reaches a network or an encoder.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelPublishSheet from './ReelPublishSheet.svelte';
import type { PublishReelDeps } from '$lib/reels/publishReel';
import { VideoPrepareError } from '$lib/video/prepareVideoForUpload';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The sheet fades in, and a test unmounts it mid-fade.
afterAll(adoptTransitionAnimations());

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));
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

function deps(): PublishReelDeps {
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

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(d: PublishReelDeps, onclose = vi.fn()) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelPublishSheet, {
      target,
      props: {
        clip: { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' },
        limits: { maxDurationMs: 90_000, retentionDays: 30, warningWindowDays: 7 },
        onclose,
        deps: d,
      },
    })
  );
  await settle();
  const submit = () =>
    [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.reels_publish_submit()
    )!;
  return { target, submit, onclose };
}

beforeEach(() => {
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

describe('ReelPublishSheet', () => {
  it('publishes the caption as a reel and lands on the feed', async () => {
    const d = deps();
    const { target, submit } = await render(d);
    const caption = target.querySelector<HTMLTextAreaElement>('[data-reel-caption]')!;
    caption.value = '  first reel  ';
    caption.dispatchEvent(new Event('input', { bubbles: true }));
    submit().click();
    await settle();
    expect(d.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reel', markdown: 'first reel', durationMs: 3000 })
    );
    expect(goto).toHaveBeenCalledWith('/posts', { replaceState: true });
  });

  it('says why a publish was refused and stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    vi.mocked(d.prepare).mockRejectedValueOnce(new VideoPrepareError('unsupported', 'no'));
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      m.video_prepare_unsupported()
    );
    expect(goto).not.toHaveBeenCalled();
  });

  it('a cancelled re-encode shows nothing', async () => {
    const d = deps();
    vi.mocked(d.prepare).mockRejectedValueOnce(new VideoPrepareError('aborted', 'cancel'));
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(d.createPost).not.toHaveBeenCalled();
  });

  it('the back arrow returns to the take', async () => {
    const { target, onclose } = await render(deps());
    target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.click();
    await settle();
    expect(onclose).toHaveBeenCalled();
  });
});
