// @vitest-environment happy-dom
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
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { m } from '$lib/paraglide/messages';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The sheet fades in, and a test unmounts it mid-fade.
afterAll(adoptTransitionAnimations());

const goto = vi.fn();
const postAs = vi.hoisted(() => ({
  list: [] as { id: string; name: string; logoUrl: string | null }[],
}));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve(postAs.list),
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

async function render(d: PublishReelDeps, onclose = vi.fn(), extra: Record<string, unknown> = {}) {
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
        ...extra,
      },
    })
  );
  await settle();
  // The attribute the REEL-2 rig row presses, so a rename fails here first.
  const submit = () => {
    const button = target.querySelector<HTMLButtonElement>('[data-reel-publish-submit]')!;
    expect(button.textContent?.trim()).toBe(m.reels_publish_submit());
    return button;
  };
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
  postAs.list = [];
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

  it('a back during the re-encode stops it', async () => {
    const d = deps();
    let signal: AbortSignal | undefined;
    vi.mocked(d.prepare).mockImplementationOnce(
      (_file, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener('abort', () => reject(new VideoPrepareError('aborted', 'x')));
        })
    );
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.click();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(d.createPost).not.toHaveBeenCalled();
  });

  it('a dismiss once the upload has begun cancels nothing, and does not say it did', async () => {
    const debug = vi.spyOn(console, 'debug');
    const d = deps();
    let release: () => void = () => {};
    vi.mocked(d.upload).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              type: 'video',
              mediaId: 'm-1',
              key: 'k',
              iv: 'i',
              mimeType: 'video/mp4',
              size: 4,
            });
        })
    );
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.click();
    await settle();
    release();
    await settle();
    expect(debug.mock.calls.flat().join('\n')).not.toContain('cancelled by the member');
    expect(d.createPost).toHaveBeenCalled();
  });

  it('the back arrow returns to the take', async () => {
    const { target, onclose } = await render(deps());
    target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.click();
    await settle();
    expect(onclose).toHaveBeenCalled();
  });

  it("the preview box is 9:16 and shows Canari's poster, never the engine's, until its first frame", async () => {
    const { target } = await render(deps());
    const box = target.querySelector<HTMLElement>('[data-reel-publish-preview]')!;
    const video = box.querySelector('video')!;
    expect(box.className).toContain('aspect-9/16');
    expect(video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
    expect(box.querySelector('[aria-hidden="true"].bg-linear-to-br')).not.toBeNull();

    video.dispatchEvent(new Event('loadeddata'));
    flushSync();
    expect(box.querySelector('[aria-hidden="true"].bg-linear-to-br')).toBeNull();
  });
});

describe('ReelPublishSheet reached from the new-post composer (one camera, one behaviour, 2026-10-19)', () => {
  function composer() {
    return { caption: 'from the composer', identity: '', onkeep: vi.fn(), onpublished: vi.fn() };
  }

  it('says BEFORE publishing that the CanaReel is deleted after its days, and starts from the text', async () => {
    const c = composer();
    const { target } = await render(deps(), vi.fn(), { composer: c });
    const notice = target.querySelector('[data-reel-publish-composer-notice]');
    expect(notice?.textContent?.trim()).toBe(m.reels_publish_from_composer_notice({ days: 30 }));
    expect(target.querySelector<HTMLTextAreaElement>('[data-reel-caption]')!.value).toBe(
      'from the composer'
    );
  });

  it('publishes a reel and hands the landing to the composer, with no navigation', async () => {
    const d = deps();
    const c = composer();
    const { submit } = await render(d, vi.fn(), { composer: c });
    submit().click();
    await settle();
    expect(d.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reel', markdown: 'from the composer', durationMs: 3000 })
    );
    expect(c.onpublished).toHaveBeenCalledWith('');
    expect(goto).not.toHaveBeenCalled();
  });

  it('"Garder comme post" hands the video back and publishes nothing', async () => {
    const d = deps();
    const c = composer();
    const { target } = await render(d, vi.fn(), { composer: c });
    const keep = target.querySelector<HTMLButtonElement>('[data-reel-keep-as-post]')!;
    expect(keep.textContent?.trim()).toBe(m.reels_publish_keep_as_post());
    keep.click();
    await settle();
    expect(c.onkeep).toHaveBeenCalledTimes(1);
    expect(d.createPost).not.toHaveBeenCalled();
  });

  it('on the CanaReels tab there is neither the notice nor the way back to a post', async () => {
    const { target } = await render(deps());
    expect(target.querySelector('[data-reel-publish-composer-notice]')).toBeNull();
    expect(target.querySelector('[data-reel-keep-as-post]')).toBeNull();
  });
});

describe('ReelPublishSheet - review of #2124', () => {
  /** The sheet's own history entry: the last one it pushed. */
  const sheetClose = () => vi.mocked(pushHistoryOverlay).mock.calls.at(-1)![0];

  it('a Back once the upload has begun is refused: the sheet stays, and the take is published ONCE', async () => {
    let finishUpload: () => void = () => {};
    const d = deps();
    d.upload = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PublishReelDeps['upload']>>>((r) => {
          finishUpload = () =>
            r({ type: 'video', mediaId: 'm-1', key: 'k', iv: 'i', mimeType: 'video/mp4', size: 4 });
        })
    );
    const { target, submit, onclose } = await render(d);
    submit().click();
    await settle();
    expect(d.upload).toHaveBeenCalledTimes(1);

    sheetClose()('back');
    await settle();
    expect(onclose).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(
      target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.disabled
    ).toBe(true);
    // The entry is given back, so the next Back is refused the same way.
    expect(sheetClose()).toBeTypeOf('function');

    finishUpload();
    await settle();
    expect(d.createPost).toHaveBeenCalledTimes(1);
  });

  it('leaving the screen during the upload still closes the sheet (nothing is held over the next page)', async () => {
    const d = deps();
    d.upload = vi.fn(() => new Promise<never>(() => {}));
    const { submit, onclose } = await render(d);
    submit().click();
    await settle();
    sheetClose()('navigation');
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('"Garder comme post" hands back the caption and identity AS EDITED in the step', async () => {
    const onkeep = vi.fn();
    const { target } = await render(deps(), vi.fn(), {
      composer: { caption: 'start', identity: '', onkeep, onpublished: vi.fn() },
    });
    const caption = target.querySelector<HTMLTextAreaElement>('[data-reel-caption]')!;
    caption.value = 'edited here';
    caption.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    target.querySelector<HTMLButtonElement>('[data-reel-keep-as-post]')!.click();
    expect(onkeep).toHaveBeenCalledWith('edited here', '');
  });

  it('from the composer the deletion notice is a note and takes the focus as the step opens', async () => {
    const { target } = await render(deps(), vi.fn(), {
      composer: { caption: '', identity: '', onkeep: vi.fn(), onpublished: vi.fn() },
    });
    const notice = target.querySelector<HTMLElement>('[data-reel-publish-composer-notice]')!;
    expect(notice.getAttribute('role')).toBe('note');
    // The warning token, which flips with the theme - never the raw amber scale.
    expect(notice.className).toContain('bg-amber-warn/10');
    expect(notice.className).not.toMatch(/amber-[0-9]/);
    expect(document.activeElement).toBe(notice);
  });

  it('on the tab the focus moves into the step too, on its title', async () => {
    const { target } = await render(deps());
    expect(document.activeElement).toBe(target.querySelector('h1'));
  });

  it("the composer's association is the step's starting identity", async () => {
    postAs.list = [{ id: 'asso-1', name: 'BDE Test', logoUrl: null }];
    const { target } = await render(deps(), vi.fn(), {
      composer: { caption: '', identity: 'asso-1', onkeep: vi.fn(), onpublished: vi.fn() },
    });
    expect(target.textContent).toContain('BDE Test');
  });
});
