// @vitest-environment happy-dom
/**
 * THE MINESWEEPER BADGE (owner, 2026-11-10): "🏆 Démineur #16", small, linking to the Games page,
 * the time only in its tooltip - and nothing for a player with no verified time.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({ standing: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/minesweeper/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchMinesweeperUserStanding: api.standing,
}));

import ProfileMinesweeperBadge from './ProfileMinesweeperBadge.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;
async function render() {
  component = mount(ProfileMinesweeperBadge, { target: document.body, props: { userId: 'u1' } });
  for (let i = 0; i < 4; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the profile minesweeper badge', () => {
  it('is a link to the games page reading the rank only, the time in its tooltip', async () => {
    api.standing.mockResolvedValue({ personalBestMs: 61_000, rank: 16 });
    await render();
    const badge = document.querySelector('[data-testid="minesweeper-badge"]') as HTMLAnchorElement;
    expect(badge.getAttribute('href')).toBe('/games');
    expect(badge.textContent?.trim()).toBe(m.minesweeper_profile_badge({ rank: '16' }));
    expect(badge.textContent).not.toContain('1:01');
    expect(badge.title).toContain('1:01');
  });

  it('draws nothing for a player with no verified time', async () => {
    api.standing.mockResolvedValue({ personalBestMs: null, rank: null });
    await render();
    expect(document.querySelector('[data-testid="minesweeper-badge"]')).toBeNull();
  });
});
