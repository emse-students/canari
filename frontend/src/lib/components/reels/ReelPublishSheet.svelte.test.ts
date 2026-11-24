// @vitest-environment happy-dom
/**
 * The publish step as the member meets it: "Publier" hands the take to the publish queue and lands
 * on the feed (2026-11-24: the queue sends it, resumably, and the member may leave the app); a take
 * the device could not keep is said and stays; the back arrow returns to the take. The queue's door
 * is injected (`deps`); nothing reaches a network, an encoder or IndexedDB.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelPublishSheet from './ReelPublishSheet.svelte';
import type { PublishReelDeps } from '$lib/reels/publishReel';
import type { QueuedPost } from '$lib/posts/publishQueue/publishQueueStore';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { m } from '$lib/paraglide/messages';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The sheet fades in, and a test unmounts it mid-fade.
afterAll(adoptTransitionAnimations());

const goto = vi.fn();
const postAs = vi.hoisted(() => ({
  list: [] as { id: string; name: string; logoUrl: string | null; type?: string }[],
}));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve(postAs.list),
}));
// The reach picker's options (owner, 2026-11-10): one institution with two spaces.
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  getInstitutionReachOptions: () =>
    Promise.resolve({
      spaces: [
        { formation: 'ICM', campus: 'saint-etienne' },
        { formation: 'ISMIN', campus: 'saint-etienne' },
      ],
    }),
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));

const mounted: Record<string, unknown>[] = [];

function deps(): PublishReelDeps & { enqueue: ReturnType<typeof vi.fn> } {
  return {
    userId: () => 'alice',
    enqueue: vi.fn(async () => {}),
  };
}

/** The post the step queued (the last one). */
function queuedPost(d: ReturnType<typeof deps>): QueuedPost {
  return d.enqueue.mock.calls.at(-1)![1] as QueuedPost;
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
        limits: {
          maxDurationMs: 90_000,
          chatMaxDurationMs: 60_000,
          maxAspectRatio: 0.8,
          retentionDays: 365,
          warningWindowDays: 7,
        },
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
  it('queues the caption and the take, then lands on the feed', async () => {
    const d = deps();
    const { target, submit } = await render(d);
    const caption = target.querySelector<HTMLTextAreaElement>('[data-reel-caption]')!;
    caption.value = '  first reel  ';
    caption.dispatchEvent(new Event('input', { bubbles: true }));
    submit().click();
    await settle();
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.enqueue.mock.calls[0][0]).toBe('alice');
    const post = queuedPost(d);
    expect(post.payload).toEqual({ markdown: 'first reel' });
    expect(post.media[0].take).toEqual({ maxDurationMs: 90_000 });
    expect(goto).toHaveBeenCalledWith('/posts', { replace: true });
  });

  it('a take the device could not keep is said, and the step stays with it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    d.enqueue.mockRejectedValueOnce(new Error('write failed'));
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      m.publish_queue_enqueue_error()
    );
    expect(goto).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false);
  });

  it('a full disk says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    d.enqueue.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const { target, submit } = await render(d);
    submit().click();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      m.publish_queue_enqueue_storage_full()
    );
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
    return {
      start: {
        caption: 'from the composer',
        identity: '',
        studentsOnly: false,
        reach: { spaces: [], public: null },
      },
      onpublished: vi.fn(),
    };
  }

  it('says BEFORE publishing that the CanaReel is deleted after its year, and starts from the text', async () => {
    const c = composer();
    const { target } = await render(deps(), vi.fn(), { composer: c });
    const notice = target.querySelector('[data-reel-publish-composer-notice]');
    expect(notice?.textContent?.trim()).toBe(
      m.reels_publish_from_composer_notice({
        seconds: 90,
        lifetime: m.reels_lifetime_years({ count: 1 }),
      })
    );
    expect(target.querySelector<HTMLTextAreaElement>('[data-reel-caption]')!.value).toBe(
      'from the composer'
    );
  });

  it('queues the reel and hands the landing to the composer, with no navigation', async () => {
    const d = deps();
    const c = composer();
    const { submit } = await render(d, vi.fn(), { composer: c });
    submit().click();
    await settle();
    expect(queuedPost(d).payload).toEqual({ markdown: 'from the composer' });
    expect(c.onpublished).toHaveBeenCalledWith('');
    expect(goto).not.toHaveBeenCalled();
  });

  it('on the CanaReels tab there is no composer notice, and from the composer no way back to a post', async () => {
    const { target } = await render(deps());
    expect(target.querySelector('[data-reel-publish-composer-notice]')).toBeNull();
    // Owner, 2026-11-09: a vertical take of 90 s or less IS a CanaReel, so "Garder comme post" is gone.
    const fromComposer = await render(deps(), vi.fn(), { composer: composer() });
    expect(fromComposer.target.querySelector('[data-reel-keep-as-post]')).toBeNull();
  });
});

describe('ReelPublishSheet - review of #2124', () => {
  /** The sheet's own history entry: the last one it pushed. */
  const sheetClose = () => vi.mocked(pushHistoryOverlay).mock.calls.at(-1)![0];

  it('a Back while the take is written to the device is refused: the sheet stays, and the take is queued ONCE', async () => {
    let finishWrite: () => void = () => {};
    const d = deps();
    d.enqueue.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finishWrite = r;
        })
    );
    const { target, submit, onclose } = await render(d);
    submit().click();
    await settle();
    expect(d.enqueue).toHaveBeenCalledTimes(1);

    sheetClose()('back');
    await settle();
    expect(onclose).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(
      target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_publish_back()}"]`)!.disabled
    ).toBe(true);
    // The entry is given back, so the next Back is refused the same way.
    expect(sheetClose()).toBeTypeOf('function');

    finishWrite();
    await settle();
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith('/posts', { replace: true });
  });

  it('leaving the screen during the write still closes the sheet (nothing is held over the next page)', async () => {
    const d = deps();
    d.enqueue.mockImplementationOnce(() => new Promise<never>(() => {}));
    const { submit, onclose } = await render(d);
    submit().click();
    await settle();
    sheetClose()('navigation');
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('from the composer the deletion notice is a note and takes the focus as the step opens', async () => {
    const { target } = await render(deps(), vi.fn(), {
      composer: {
        start: {
          caption: '',
          identity: '',
          studentsOnly: false,
          reach: { spaces: [], public: null },
        },
        onpublished: vi.fn(),
      },
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
      composer: {
        start: {
          caption: '',
          identity: 'asso-1',
          studentsOnly: false,
          reach: { spaces: [], public: null },
        },
        onpublished: vi.fn(),
      },
    });
    expect(target.textContent).toContain('BDE Test');
  });
});

describe('ReelPublishSheet - "Entre étudiants" both ways with the composer (review of #3010)', () => {
  it('starts from the composer switch, and publishes it as edited here', async () => {
    postAs.list = [{ id: 'list-1', name: 'Liste Kraken', logoUrl: null, type: 'list' }];
    const d = deps();
    const { target, submit } = await render(d, vi.fn(), {
      composer: {
        start: {
          caption: 'x',
          identity: 'list-1',
          studentsOnly: true,
          reach: { spaces: [], public: null },
        },
        onpublished: vi.fn(),
      },
    });
    const toggle = target.querySelector<HTMLInputElement>(
      '[data-students-only-switch] input[type="checkbox"]'
    )!;
    expect(toggle.checked).toBe(true);
    toggle.click();
    flushSync();
    submit().click();
    await settle();
    expect(queuedPost(d).payload).not.toHaveProperty('studentsOnly');
  });
});

describe('ReelPublishSheet - the reach of an institution reel (owner, 2026-11-10)', () => {
  it('holds "Publier" until a space and a public are chosen, then sends the reach', async () => {
    postAs.list = [{ id: 'inst-1', name: 'Mines', logoUrl: null, type: 'institution' }];
    const d = deps();
    const { target, submit } = await render(d, vi.fn(), {
      composer: {
        start: {
          caption: 'x',
          identity: 'inst-1',
          studentsOnly: false,
          reach: { spaces: [], public: null },
        },
        onpublished: vi.fn(),
      },
    });
    await settle();
    expect(target.querySelector('[data-institution-reach-picker]')).not.toBeNull();
    expect(submit().disabled).toBe(true);
    target.querySelector<HTMLInputElement>('[data-reach-space="ICM|saint-etienne"]')!.click();
    flushSync();
    expect(submit().disabled).toBe(true);
    target.querySelector<HTMLInputElement>('[data-reach-public="staff"]')!.click();
    flushSync();
    expect(submit().disabled).toBe(false);
    submit().click();
    await settle();
    expect(queuedPost(d).payload).toMatchObject({
      associationId: 'inst-1',
      reach: { spaces: [{ formation: 'ICM', campus: 'saint-etienne' }], public: 'staff' },
    });
  });
});

describe('ReelPublishSheet - a take also sent to conversations (15.5)', () => {
  function chatTake() {
    return { id: 'take-1', endWait: vi.fn(), onQueued: vi.fn() };
  }

  it("queued, the take id travels with the post and the wait is the QUEUE's: the step never ends it", async () => {
    const d = deps();
    const take = chatTake();
    const { submit } = await render(d, vi.fn(), { chatTake: take });
    submit().click();
    await settle();
    expect(queuedPost(d).chatTakeId).toBe('take-1');
    expect(take.onQueued).toHaveBeenCalledTimes(1);
    while (mounted.length) unmount(mounted.pop()!);
    expect(take.endWait).not.toHaveBeenCalled();
  });

  it('left without "Publier", the step ends the wait: the take uploads its own', async () => {
    const take = chatTake();
    await render(deps(), vi.fn(), { chatTake: take });
    while (mounted.length) unmount(mounted.pop()!);
    expect(take.endWait).toHaveBeenCalledWith('take-1');
  });

  it('a take the device could not keep leaves the wait to the step, which ends it when left', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    d.enqueue.mockRejectedValueOnce(new Error('write failed'));
    const take = chatTake();
    const { submit } = await render(d, vi.fn(), { chatTake: take });
    submit().click();
    await settle();
    expect(take.onQueued).not.toHaveBeenCalled();
    while (mounted.length) unmount(mounted.pop()!);
    expect(take.endWait).toHaveBeenCalledWith('take-1');
  });
});
