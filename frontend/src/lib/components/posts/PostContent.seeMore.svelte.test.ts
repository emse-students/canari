/**
 * "VOIR PLUS" CLAMPS THE RENDERED POST - IT NEVER CUTS ITS MARKDOWN (user, 2026-09-28).
 *
 * The post used to be cut at 400 characters of SOURCE and then rendered, so a cut inside
 * `**gras**` left an unmatched `**` on screen and the emphasis only appeared once "Voir plus"
 * revealed its closing pair. It is rendered whole now and clamped by lines; the button exists when
 * the rendered box is taller than the clamp, which only a measurement can say.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostContent from './PostContent.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A post whose bold run straddles the old 400-character cut. */
const LONG = `${'Un texte assez long. '.repeat(18)}**ce passage en gras traverse la coupure** et la suite.`;

/** Makes every post box report `scrollHeight` > `clientHeight` (overflowing) or not. */
function stubOverflow(overflowing: boolean) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(overflowing ? 500 : 100);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
}

async function mountPost(markdown: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = { id: 'p1', markdown, media: [], createdAt: new Date(0).toISOString() } as never;
  const app = mount(PostContent, { target, props: { post } });
  mounted.push(() => void unmount(app));
  flushSync();
  await tick();
  flushSync();
  return target;
}

function button(target: HTMLElement): HTMLButtonElement | null {
  return target.querySelector('button');
}

describe('PostContent "Voir plus"', () => {
  it('renders the whole Markdown while collapsed - no raw ** and the bold intact', async () => {
    expect(LONG.indexOf('**')).toBeLessThan(400);
    expect(LONG.lastIndexOf('**')).toBeGreaterThan(400);
    stubOverflow(true);
    const target = await mountPost(LONG);

    const box = target.querySelector('.post-markdown')!;
    expect(box.textContent).not.toContain('**');
    expect(box.querySelector('strong')?.textContent).toBe('ce passage en gras traverse la coupure');
    expect(box.classList.contains('line-clamp-8')).toBe(true);
  });

  it('offers "Voir plus" when the rendered post overflows, and folds back with "Voir moins"', async () => {
    stubOverflow(true);
    const target = await mountPost(LONG);
    const box = target.querySelector('.post-markdown')!;

    expect(button(target)?.textContent?.trim()).toBe('Voir plus');
    button(target)!.click();
    flushSync();
    expect(box.classList.contains('line-clamp-8')).toBe(false);
    expect(button(target)?.textContent?.trim()).toBe('Voir moins');

    button(target)!.click();
    flushSync();
    expect(box.classList.contains('line-clamp-8')).toBe(true);
  });

  it('offers nothing when the post fits - however many characters it has', async () => {
    stubOverflow(false);
    const target = await mountPost(LONG);
    expect(button(target)).toBeNull();
  });
});
