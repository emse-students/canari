// @vitest-environment happy-dom
/**
 * THE GAMES PAGE (owner, 2026-11-10): "Jouer", the reader's own record, and the Minesweeper ranking
 * overall or per promo - the promo tab opening on the reader's own promo, and asking the server for
 * that promo alone.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  board: vi.fn(),
  me: vi.fn(),
  promos: vi.fn(),
}));
vi.mock('$lib/minesweeper/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchMinesweeperLeaderboard: api.board,
  fetchMinesweeperMe: api.me,
  fetchMinesweeperPromos: api.promos,
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u-1' }));
vi.mock('$lib/components/settings/MinesweeperModal.svelte', () => ({
  default: () => {},
}));
vi.mock('svelte/transition', () => ({
  fade: () => ({ duration: 0 }),
  fly: () => ({ duration: 0 }),
}));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;
async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}
const entry = (rank: number, userId = `u${rank}`) => ({
  scoreId: `s${rank}`,
  rank,
  userId,
  displayName: `Player ${rank}`,
  durationMs: 60_000 + rank * 1000,
  moveCount: 80,
  verifiedAt: '2026-11-01T10:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue({ personalBestMs: 61_000, rank: 3 });
  api.promos.mockResolvedValue({
    promos: [
      { promo: 2027, players: 3 },
      { promo: 2026, players: 12 },
    ],
    mine: 2026,
  });
  api.board.mockImplementation(async (_limit: number, _offset: number, promo?: number) => ({
    entries: promo === undefined ? [entry(1), entry(2)] : [entry(1, 'u-1')],
    total: promo === undefined ? 2 : 1,
  }));
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the games page', () => {
  it('shows Jouer, the reader record and the overall ranking first', async () => {
    component = mount(Page, { target: document.body });
    await settle();
    expect(document.body.textContent).toContain(m.games_play());
    expect(document.querySelector('[data-testid="games-best"]')?.textContent).toContain('#3');
    expect(document.querySelectorAll('[data-testid="games-ranking"] li')).toHaveLength(2);
    expect(api.board).toHaveBeenCalledWith(25, 0, undefined);
  });

  it('opens the promo tab on the reader own promo and asks for that promo alone', async () => {
    component = mount(Page, { target: document.body });
    await settle();
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"], button')];
    tabs.find((b) => b.textContent?.trim() === m.games_tab_promo())?.click();
    await settle();
    expect(api.board).toHaveBeenLastCalledWith(25, 0, 2026);
    expect(document.querySelectorAll('[data-testid="games-ranking"] li')).toHaveLength(1);
  });

  it('says so when no promo has a ranking yet', async () => {
    api.promos.mockResolvedValue({ promos: [], mine: null });
    component = mount(Page, { target: document.body });
    await settle();
    [...document.querySelectorAll<HTMLElement>('button, [role="tab"]')]
      .find((b) => b.textContent?.trim() === m.games_tab_promo())
      ?.click();
    await settle();
    expect(document.body.textContent).toContain(m.games_promo_none());
  });
});
