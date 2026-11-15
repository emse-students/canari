// @vitest-environment happy-dom
/**
 * THE ONE CARD (owner, 2026-11-15) and the review of #3616: the arrow says the card opens something
 * and where (exit glyph out of the app, chevron inside it), stays beside a trailing control, and goes
 * when a hero's call to action already says it; a chip that repeats the title is dropped; and what
 * a banner shows is never a control of its own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import AttachmentCard from './AttachmentCard.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(AttachmentCard, {
    target,
    props: { kind: 'link', chip: 'Type', title: 'Title', tile: html('<span></span>'), ...props },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

const arrow = (t: HTMLElement) =>
  t.querySelector<HTMLElement>('[data-attachment-arrow]')?.dataset.attachmentArrow ?? null;

describe('AttachmentCard arrow', () => {
  it('reads "external" out of the app and "in-app" inside it', () => {
    expect(arrow(render({ href: 'https://x.example', external: true }))).toBe('external');
    expect(arrow(render({ href: '/forms/1' }))).toBe('in-app');
  });

  it('stays beside a trailing control, so a row that opens something still says so', () => {
    const target = render({ onclick: () => {}, trailing: html('<button>dl</button>') });
    expect(arrow(target)).toBe('in-app');
  });

  it('is absent on a card that opens nothing, and on a hero showing its call to action', () => {
    expect(arrow(render({ trailing: html('<button>dl</button>') }))).toBeNull();
    const hero = render({ href: '/forms/1', hero: true, heroAction: 'Fill' });
    expect(arrow(hero)).toBeNull();
    expect(hero.textContent).toContain('Fill');
  });
});

describe('AttachmentCard chip', () => {
  it('is dropped when the title only repeats it', () => {
    const same = render({ href: '/x', chip: 'MiGallery', title: 'migallery' });
    expect(same.querySelector('[data-attachment-chip]')).toBeNull();
    const other = render({ href: '/x', chip: 'MiGallery', title: 'Soiree' });
    expect(other.querySelector('[data-attachment-chip]')?.textContent?.trim()).toBe('MiGallery');
  });
});

describe('AttachmentCard pictures', () => {
  it('makes what the banner and the band below show inert: no focus, no tap of its own', () => {
    const target = render({
      href: '/posts/1',
      hero: true,
      banner: html('<div><button data-zoom>zoom</button></div>'),
    });
    const zoom = target.querySelector('[data-zoom]')!;
    expect(zoom.closest('[inert]')).not.toBeNull();
    expect(zoom.closest('[inert]')!.className).toContain('pointer-events-none');
    const below = render({
      href: '/posts/1',
      below: html('<div><button data-zoom2>z</button></div>'),
    });
    expect(below.querySelector('[data-zoom2]')!.closest('[inert]')).not.toBeNull();
  });
});
