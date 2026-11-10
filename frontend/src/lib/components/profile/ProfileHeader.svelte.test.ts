// @vitest-environment happy-dom
/**
 * THE PROFILE HEADER NEVER DRAWS ONE THING OVER ANOTHER (owner, 2026-11-09: the action row sat ON
 * the second line of a wrapped name).
 *
 * happy-dom has no layout, so what is asserted is the STRUCTURE that makes an overlap impossible:
 * the name and the action row are never nested, the container wraps, the identity may shrink
 * (`min-w-0`) and the action row keeps its width, nothing in the header is positioned absolutely,
 * and a chip never wraps inside its pill. The measured rendering at 360, 768 and 1100 px is in
 * docs/wiki/frontend/design-reference.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import ProfileHeader from './ProfileHeader.svelte';
import ProfileChips from './ProfileChips.svelte';
import { readFileSync } from 'node:fs';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response(null, { status: 404 }))
);

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const snippet = (html: string) => createRawSnippet(() => ({ render: () => html }));

function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ProfileHeader, {
    target,
    props: {
      userId: 'u1',
      name: 'Lucas HAUSNER-DE-LA-MARQUETTERIE',
      details: snippet('<p data-d>details</p>'),
      actions: snippet('<button data-a>Suivre</button>'),
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('ProfileHeader', () => {
  it('keeps the name and the action row as siblings, never one inside the other', () => {
    const el = render();
    const header = el.querySelector('[data-profile-header]')!;
    const name = el.querySelector('[data-profile-name]')!;
    const actions = el.querySelector('[data-profile-actions]')!;
    expect(name.closest('[data-profile-actions]')).toBeNull();
    expect(actions.contains(name)).toBe(false);
    expect(actions.parentElement).toBe(header);
    expect(el.querySelector('[data-profile-identity]')!.parentElement).toBe(header);
    expect(actions.querySelector('[data-a]')).not.toBeNull();
  });

  it('wraps the action row below the identity when there is no room, and lets the name wrap', () => {
    const el = render();
    const header = el.querySelector('[data-profile-header]')!;
    const identity = el.querySelector('[data-profile-identity]')!;
    const actions = el.querySelector('[data-profile-actions]')!;
    expect(header.className).toContain('sm:flex-wrap');
    expect(identity.className).toContain('min-w-0');
    expect(identity.className).toContain('sm:basis-[26rem]');
    // On a phone the row takes the whole line, so it is always BELOW the name there.
    expect(actions.className).toContain('w-full');
    expect(actions.className).toContain('sm:shrink-0');
    expect(el.querySelector('[data-profile-name]')!.className).toContain('wrap-break-word');
  });

  it('positions nothing over anything', () => {
    const el = render();
    // The avatar fills its own circle with an absolute placeholder; that is inside the avatar.
    const header = el.querySelector('[data-profile-header]')!;
    const avatar = header.querySelector('[data-profile-identity] > div')!;
    const nodes = [header, ...Array.from(header.querySelectorAll('*'))].filter(
      (n) => !avatar.contains(n)
    );
    for (const node of nodes) {
      expect(String(node.getAttribute('class') ?? '')).not.toMatch(/(^|\s)absolute(\s|$)/);
    }
  });
});

describe('ProfileChips', () => {
  it('never wraps a chip inside its pill, and lets the row of chips wrap instead', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ProfileChips, {
      target,
      props: {
        profile: {
          cursus: [{ formation: 'ICM', promo: 2027 }],
          posts: [],
          campus: 'saint_etienne',
        } as never,
      },
    });
    mounted.push(() => void unmount(app));
    flushSync();
    const row = target.querySelector('[data-profile-chips]')!;
    expect(row.className).toContain('flex-wrap');
    const chips = Array.from(row.children);
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.className).toContain('whitespace-nowrap');
      expect(chip.className).not.toContain('uppercase');
    }
  });

  it('isolates the avatar box so an avatar badge stacks above the story ring', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ProfileHeader, {
      target,
      props: { userId: 'u1', name: 'A', avatarBadge: snippet('<button data-badge>x</button>') },
    });
    mounted.push(() => void unmount(app));
    flushSync();
    const box = target.querySelector('[data-badge]')!.parentElement!;
    expect(box.classList.contains('isolate')).toBe(true);
    expect(box.classList.contains('relative')).toBe(true);
  });

  it('stacks the own-profile camera badge above the ring (z-10)', () => {
    const page = readFileSync('src/routes/profile/(me)/+page.svelte', 'utf8');
    const button = page.slice(page.indexOf('onclick={changeProfilePhoto}'));
    expect(button.slice(0, button.indexOf('>')).replace(/\s+/g, ' ')).toMatch(
      /absolute right-0 bottom-0 z-10 /
    );
  });
});
