// @vitest-environment happy-dom
/**
 * The post sheet is ONE drop zone (owner, 2026-11-08: dropping a file attached nothing): a drop on
 * the sheet's padding or toolbar attaches as much as one on the editor, the drag is claimed
 * (`dragover` prevented, effect following the source), a drop state is drawn, and a web image with
 * no file is fetched or refused out loud.
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
  listLiveAssociations: () => Promise.resolve([]),
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

type Shape = {
  files?: File[];
  data?: Record<string, string>;
  effectAllowed?: string;
};

/** A drag event whose transfer is shaped like a browser's: `types` lists what is carried. */
function dragEvent(type: string, target: EventTarget, shape: Shape): DragEvent {
  const data = shape.data ?? {};
  const types = [...(shape.files?.length ? ['Files'] : []), ...Object.keys(data)];
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: shape.files ?? [],
      items: [],
      types,
      effectAllowed: shape.effectAllowed ?? 'all',
      dropEffect: 'none',
      getData: (t: string) => data[t] ?? '',
    },
  });
  target.dispatchEvent(event);
  flushSync();
  return event;
}

const attached = (target: HTMLElement) => target.querySelectorAll('[role="listitem"]').length;
const png = () => new File(['x'], 'a.png', { type: 'image/png' });
const sheetBody = (target: HTMLElement) => target.querySelector('.overflow-y-auto')!;
const editor = (target: HTMLElement) => target.querySelector('[role="textbox"]')!;

describe('CreatePostForm - the sheet is one drop zone', () => {
  it('attaches a real file dropped on the sheet outside the editor, and claims the drag', async () => {
    const target = await open();
    const over = dragEvent('dragover', sheetBody(target), { files: [png()] });
    expect(over.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain(m.post_drop_overlay());
    dragEvent('drop', sheetBody(target), { files: [png()] });
    expect(attached(target)).toBe(1);
    // The overlay fades out, so it leaves the DOM after its outro rather than at once.
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(m.post_drop_overlay()));
  });

  it('attaches a real file dropped on the editor exactly once', async () => {
    const target = await open();
    dragEvent('drop', editor(target), { files: [png()] });
    expect(attached(target)).toBe(1);
  });

  it('announces the effect the source allows: a move-only web image is not forced to copy', async () => {
    const target = await open();
    const shape = {
      data: { 'text/uri-list': 'https://cdn.example/cat.png' },
      effectAllowed: 'move',
    };
    const over = dragEvent('dragover', sheetBody(target), shape);
    expect((over.dataTransfer as DataTransfer).dropEffect).toBe('move');
    const editorOver = dragEvent('dragover', editor(target), shape);
    expect((editorOver.dataTransfer as DataTransfer).dropEffect).toBe('move');
  });

  it('fetches a web image dropped with no file and attaches it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' })))
    );
    const target = await open();
    dragEvent('drop', sheetBody(target), {
      data: { 'text/uri-list': 'https://cdn.example/cat.png' },
    });
    await vi.waitFor(() => expect(attached(target)).toBe(1));
    expect(toast).not.toHaveBeenCalled();
  });

  it('says so when the host refuses, and attaches nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const target = await open();
    dragEvent('drop', editor(target), {
      data: { 'text/html': '<img src="https://other.example/cat.png">' },
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(m.composer_drop_web_image_refused()));
    expect(attached(target)).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('other.example'));
  });

  it('refuses a local file address instead of attaching or pasting it', async () => {
    const target = await open();
    dragEvent('drop', sheetBody(target), {
      data: { 'text/uri-list': 'file:///home/u/a.png', 'text/plain': '/home/u/a.png' },
    });
    expect(toast).toHaveBeenCalledWith(m.composer_drop_file_unreadable());
    expect(attached(target)).toBe(0);
  });
});
