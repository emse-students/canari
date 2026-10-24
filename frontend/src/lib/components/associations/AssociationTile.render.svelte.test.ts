// @vitest-environment happy-dom
/**
 * THE ONE ASSOCIATION TILE, RENDERED: what it keeps that the five copies did not have, and what a
 * LIST's card stopped saying (user, 2026-09-22).
 *
 * The list asks, all about not repeating something the page already says:
 *
 * - **the "Liste 2026" pill is gone** - *"c'est deja dans Campagnes 2026, pourquoi doubler ?"* The
 *   shelf heading above the card carries the year.
 * - **the member count is gone FROM LISTS ONLY.** `/associations` keeps it: "0 membres" on a list
 *   whose members are not registered yet answers nothing. The tile is shared between the two pages,
 *   so this is a condition rather than a deletion.
 * - **the second theme renders small, under the main one** - a campaign list can run two at once,
 *   and the second one is subordinate.
 *
 * WP-T5 (docs/wiki/test-suite-reform.md): this replaced `associationTileList.test.ts` and the "one
 * tile" half of `AssociationTile.test.ts`, which pinned the same properties as SPELLINGS of the
 * markup (`const showsMemberCount = $derived(!isList);`, an `indexOf` chain over `{:else}`) - a
 * rewording that kept the behaviour broke them, and a condition moved elsewhere kept them green.
 * Mounting the tile asks the card itself. Each case was shown failing on its defect re-planted.
 * The CLASSES asserted below are as far as happy-dom goes: it computes no style, so the measured
 * line boxes are in the component's docblock and these pin the utilities that produced them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

// The logo cache resolves a URL to a blob through Cache Storage; the tile's question is WHICH URL.
vi.mock('$lib/utils/associationLogoCache', () => ({
  resolveAssociationLogoDisplayUrl: (url: string) => Promise.resolve(url),
  releaseAssociationLogoDisplayUrl: () => {},
}));
// The second logo's URL is spelled in ONE place. A mark only that derivation produces is how the
// rendered card proves it went through it, rather than through a second spelling of the same path.
// The mark is PATH-shaped because the avatar draws only a path or an http(s) URL (`imageSrcOrNull`).
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  associationSecondLogoSrc: (id: string | null | undefined) => (id ? `/derived/${id}` : null),
}));
// The accent has ONE derivation (`associations/accent.ts`); a colour only it returns proves the tile
// asked it rather than seeding a hue of its own.
vi.mock('$lib/associations/accent', () => ({ associationAccent: () => '#123456' }));

import AssociationTile from './AssociationTile.svelte';
import type { Association } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function association(overrides: Partial<Association>): Association {
  return {
    id: 'a-1',
    name: 'Main Name',
    slug: 'main',
    description: null,
    bioMarkdown: null,
    logoUrl: null,
    lydiaOnboardingComplete: false,
    isBDE: false,
    documentQuotaBytes: 0,
    createdBy: 'u-1',
    type: 'association',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Mounts one tile and lets the avatar's logo resolution land. Returns the card's root. */
async function render(a: Association, isMember = false): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(AssociationTile, { target, props: { association: a, href: '/x', isMember } });
  mounted.push(() => void unmount(app));
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
  return target;
}

const text = (root: HTMLElement) => root.textContent?.replace(/\s+/g, ' ') ?? '';

describe('a list card repeats nothing its shelf already says', () => {
  it('draws no promo pill', async () => {
    const root = await render(association({ type: 'list', promo: 2026 }));
    expect(text(root)).not.toContain(m.assoc_list_promo_badge({ promo: 2026 }));
    expect(text(root)).not.toContain('2026');
  });

  it('shows the member count only where the row is not a list', async () => {
    const count = m.assoc_member_count_many({ count: 12 });
    expect(text(await render(association({ memberCount: 12 })))).toContain(count);
    expect(text(await render(association({ type: 'list', memberCount: 12 })))).not.toContain(count);
  });

  it('keeps the archived and member notes on both kinds', async () => {
    for (const type of ['association', 'list'] as const) {
      expect(text(await render(association({ type, archived: true }))), type).toContain(
        m.assoc_list_archived_badge()
      );
      expect(text(await render(association({ type }), true)), type).toContain(
        m.assoc_list_member_badge()
      );
    }
  });
});

describe('a list card shows its second theme beneath the main one', () => {
  it('draws it when EITHER half is present', async () => {
    // A list can be renamed before its second logo is uploaded, and the logo can land before the
    // name is decided. Requiring both would hide whichever arrived first.
    const named = await render(association({ type: 'list', name2: 'Fake Name' }));
    expect(text(named)).toContain('Fake Name');
    const logoOnly = await render(association({ type: 'list', logoMediaId2: 'm-2' }));
    expect(logoOnly.querySelectorAll('img')).toHaveLength(1);
  });

  it('draws it smaller than the main logo, through the one derivation of its URL', async () => {
    const root = await render(
      association({ type: 'list', logoUrl: '/api/media/public/m-1', logoMediaId2: 'm-2' })
    );
    const [main, second] = [...root.querySelectorAll('img')];
    expect(main.className).toContain('w-12'); // `lg`, 48px
    expect(second.className).toContain('w-6'); // `sm`, 24px
    expect(second.getAttribute('src')).toMatch(/\/derived\/m-2$/);
  });

  it('never labels the second theme with the main name', async () => {
    // The fallback exists for the AVATAR's initials only - a label falling back would print the
    // same name twice, one under the other.
    const root = await render(association({ type: 'list', logoMediaId2: 'm-2' }));
    expect(text(root).split('Main Name')).toHaveLength(2);
  });

  it('shows nothing of the second theme on a regular association', async () => {
    const root = await render(association({ name2: 'Fake Name', logoMediaId2: 'm-2' }));
    expect(text(root)).not.toContain('Fake Name');
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('the one tile keeps what the copies did not have', () => {
  it('wraps the name instead of truncating it', async () => {
    const root = await render(association({ description: 'A description.' }));
    const heading = root.querySelector('h3')!;
    expect(heading.textContent?.trim()).toBe('Main Name');
    // Anchored to the HEADING: the description clamps to three lines too.
    expect(heading.classList.contains('line-clamp-3')).toBe(true);
    // The floor under the wrap: an unbroken token would otherwise widen its grid column.
    expect(heading.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(root.querySelector('.truncate')).toBeNull();
  });

  it('clamps the description on the container, which is where it was measured to work', async () => {
    // Measured in a browser at a 240px column, 2026-09-13: clamping the first PARAGRAPH instead
    // rendered 95px where three lines (57px) were asked for.
    const root = await render(association({ description: 'First paragraph.\n\nSecond one.' }));
    const markdown = root.querySelector('.post-markdown')!;
    expect(markdown.textContent).toContain('Second one.');
    expect(markdown.parentElement!.classList.contains('line-clamp-3')).toBe(true);
    expect(root.querySelector('p.line-clamp-3, .post-markdown .line-clamp-3')).toBeNull();
  });

  it("says the reader's role where it knows one, in place of a count it was never given", async () => {
    // `/api/associations/me/list` returns `role` and NO `memberCount`, so the footer printed
    // "0 membres" on every card of "Mes associations".
    const withRole = await render(
      association({ role: 'Trésorier', memberCount: 0, description: 'About us.' })
    );
    const all = text(withRole);
    expect(all.split('Trésorier')).toHaveLength(2); // once: MOVED out of the header, not copied
    expect(all).not.toContain(m.assoc_member_count_many({ count: 0 }));
    // BELOW the description, in the same yellow pill, pinned to the card's bottom edge.
    expect(all.indexOf('Trésorier')).toBeGreaterThan(all.indexOf('About us.'));
    const pill = [...withRole.querySelectorAll('span')].find((s) => s.textContent === 'Trésorier')!;
    expect(pill.classList.contains('bg-cn-yellow/20')).toBe(true);
    expect(pill.parentElement!.classList.contains('mt-auto')).toBe(true);
    // And the count survives untouched where no role is known.
    expect(text(await render(association({ memberCount: 3 })))).toContain(
      m.assoc_member_count_many({ count: 3 })
    );
  });

  it("carries the association's colour from the one derivation", async () => {
    const root = await render(association({}));
    expect(root.innerHTML).toContain('--tile-accent: #123456');
  });
});
