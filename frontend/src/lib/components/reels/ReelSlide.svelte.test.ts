// @vitest-environment happy-dom
/**
 * The reel viewer's overlay, as on Instagram (user, 2026-10-16): bottom-left, the publisher's
 * picture and name linking where the post card links (the association for an association post,
 * nowhere for a hidden author), then the description rendered as the card renders it, folded to
 * two lines with "Voir plus" unfolding it IN PLACE - without touching the player - and a tap
 * outside or "Voir moins" folding it back.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelSlide from './ReelSlide.svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('./AvatarStub.test-helper.svelte')).default,
}));

/**
 * happy-dom lays nothing out, so a clamped box reports no overflow. A rendered post text claims to
 * be taller than its box, so the fold has something to fold - the measurement itself is
 * `watchClampOverflow`'s, the same as the post card's.
 */
const proto = HTMLElement.prototype;
const original = {
  scroll: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
  client: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
};
let tall = true;
beforeAll(() => {
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('post-markdown') && tall ? 120 : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('post-markdown') ? 40 : 0;
    },
  });
});
afterAll(() => {
  if (original.scroll) Object.defineProperty(proto, 'scrollHeight', original.scroll);
  if (original.client) Object.defineProperty(proto, 'clientHeight', original.client);
});

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  tall = true;
});

function reel(overrides: Partial<PostEntity> = {}): PostEntity {
  return {
    id: 'r1',
    kind: 'reel',
    markdown: 'A **long** description',
    mentions: [],
    links: [],
    media: [{ type: 'video', mediaId: 'm-r1', key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 }],
    images: [],
    polls: [],
    authorId: 'u1',
    authorFirstName: 'Ada',
    authorLastName: 'L',
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function render(post: PostEntity, active = true) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(ReelSlide, {
    target,
    props: { post, authToken: 'tok', active, preload: false },
  });
  flushSync();
  mounted.push(() => unmount(instance));
  const q = <T extends Element>(s: string) => target.querySelector<T>(s);
  return { target, q };
}

it('shows the author picture and name, linking the profile', () => {
  const { q } = render(reel());
  const author = q<HTMLAnchorElement>('a[data-reel-author]')!;
  expect(author.getAttribute('href')).toBe('/profile/u1');
  expect(author.getAttribute('aria-label')).toBe(m.post_view_profile_label({ name: 'Ada L' }));
  expect(author.textContent).toContain('Ada L');
  expect(author.querySelector('[data-avatar-stub="u1"]')).not.toBeNull();
});

it('the author link is one named element of at least 44 px, its picture and name hidden from assistive tech', () => {
  const { q } = render(reel());
  const author = q<HTMLAnchorElement>('a[data-reel-author]')!;
  expect(author.classList.contains('min-h-11')).toBe(true);
  const children = Array.from(author.children);
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) expect(child.getAttribute('aria-hidden')).toBe('true');
});

it('a post published as an association shows and links the association', () => {
  const association = { id: 'a1', name: 'BDE Mines', slug: 'bde', logoUrl: null };
  const { q } = render(reel({ association } as Partial<PostEntity>));
  const author = q<HTMLAnchorElement>('a[data-reel-author]')!;
  expect(author.getAttribute('href')).toBe('/associations/bde');
  expect(author.textContent).toContain('BDE Mines');
});

it('a hidden author is named "Anonyme" and links nowhere', () => {
  const { q } = render(reel({ anonymous: true, authorId: undefined }));
  expect(q('a[data-reel-author]')).toBeNull();
  expect(q('[data-reel-author]')!.textContent).toContain(m.post_anonymous_label());
});

it('renders the description as the post card does, folded to two lines', () => {
  const { q } = render(reel());
  const text = q<HTMLElement>('[data-reel-caption] .post-markdown')!;
  expect(text.querySelector('strong')?.textContent).toBe('long');
  expect(text.classList).toContain('line-clamp-2');
  expect(q('[data-reel-caption-toggle]')!.textContent!.trim()).toBe(m.post_voir_plus());
});

it('a short description shows no "Voir plus"', () => {
  tall = false;
  const { q } = render(reel({ markdown: 'short' }));
  expect(q('[data-reel-caption-toggle]')).toBeNull();
});

it('"Voir plus" unfolds in place and leaves the player alone; a tap outside folds it', () => {
  const { q } = render(reel());
  const player = q('[data-post-media-stub]');
  expect(player).not.toBeNull();
  q<HTMLButtonElement>('[data-reel-caption-toggle]')!.click();
  flushSync();
  const toggle = q<HTMLButtonElement>('[data-reel-caption-toggle]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent!.trim()).toBe(m.post_voir_moins());
  expect(q('[data-reel-caption] .post-markdown')!.classList).not.toContain('line-clamp-2');
  // The unfolded text scrolls itself and is kept out of the viewer's swipe.
  const scroller = q<HTMLElement>('[data-reel-caption-open]')!;
  expect(scroller.classList).toContain('overflow-y-auto');
  // The same player, still mounted: expanding neither paused nor replaced it.
  expect(q('[data-post-media-stub]')).toBe(player);

  q<HTMLButtonElement>('[data-reel-caption-backdrop]')!.click();
  flushSync();
  expect(q('[data-reel-caption-open]')).toBeNull();
  expect(q('[data-reel-caption] .post-markdown')!.classList).toContain('line-clamp-2');
});

it('"Voir moins" folds it back', () => {
  const { q } = render(reel());
  q<HTMLButtonElement>('[data-reel-caption-toggle]')!.click();
  flushSync();
  q<HTMLButtonElement>('[data-reel-caption-toggle]')!.click();
  flushSync();
  expect(q('[data-reel-caption-toggle]')!.getAttribute('aria-expanded')).toBe('false');
  expect(q('[data-reel-caption-backdrop]')).toBeNull();
});

it('unfolded on a letterboxed reel, the text never outgrows the frame, and outside covers the slide', () => {
  // A landscape reel: its frame is far shorter than half the screen. happy-dom lays nothing out,
  // so this pins the classes that decide it - a column capped at the frame whose TEXT shrinks and
  // scrolls while the author row and the toggle keep their size.
  const { q } = render(
    reel({
      media: [
        {
          type: 'video',
          mediaId: 'm-r1',
          key: 'k',
          iv: 'i',
          mimeType: 'video/mp4',
          size: 1,
          width: 1920,
          height: 1080,
        },
      ],
    })
  );
  q<HTMLButtonElement>('[data-reel-caption-toggle]')!.click();
  flushSync();
  const block = q<HTMLElement>('[data-reel-caption]')!;
  expect(block.closest('[data-reel-frame]')).not.toBeNull();
  for (const c of ['flex', 'flex-col', 'max-h-full', 'z-20']) expect(block.classList).toContain(c);
  expect(block.firstElementChild!.classList).toContain('shrink-0');
  // A frame that does not reach the screen bottom (here: unmeasured) owes no safe-area inset; when
  // it does is `frameReachesBottom`'s, tested on its own (`reelFrame.test.ts`).
  expect(block.getAttribute('data-reel-caption-inset')).toBe('none');
  expect(block.classList).toContain('pb-4');
  expect(q('[data-reel-caption-open]')!.classList).toContain('min-h-0');
  expect(q('[data-reel-caption-toggle]')!.classList).toContain('shrink-0');
  // The tap-outside layer spans the whole slide, letterbox bands included, under the caption.
  const backdrop = q<HTMLElement>('[data-reel-caption-backdrop]')!;
  expect(backdrop.parentElement!.hasAttribute('data-reel-slide')).toBe(true);
  expect(backdrop.closest('[data-reel-frame]')).toBeNull();
  expect(backdrop.classList).toContain('z-10');
  expect(backdrop.getAttribute('aria-hidden')).toBe('true');
});

it('a reel on screen with no video draws the poster and accuses the row', () => {
  // Dev's copy of production emptied two reels' media; the viewer drew a play glyph nothing could
  // play, and nothing said why (iPhone 12, v1.2.9-alpha.4).
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { q } = render(reel({ id: 'r-empty', media: [], images: [] }));
    expect(q('[data-post-media-stub]')).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('reel r-empty carries no video');
    // A return to the same reel (its slide rebuilt) says nothing new about the same row.
    render(reel({ id: 'r-empty', media: [], images: [] }));
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});

it('a reel with its video, or one off screen, says nothing', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(reel());
    render(reel({ id: 'r-off', media: [], images: [] }), false);
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});
