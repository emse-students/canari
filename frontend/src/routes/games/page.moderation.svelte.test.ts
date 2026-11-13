// @vitest-environment happy-dom
/**
 * MINESWEEPER MODERATION IN THE ONE LEADERBOARD, the Games page (user, 2026-10-02; moved from the game's sheet, owner, 2026-11-13): a global admin can remove a score and
 * ban a player, and lift a ban. Pinned: the controls exist for an admin and for nobody else, every
 * destructive one asks first and does nothing when refused, a done action refreshes the lists, and a
 * failure is SAID on the tab instead of swallowed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  leaderboard: vi.fn(),
  me: vi.fn(),
  promos: vi.fn(),
  bans: vi.fn(),
  remove: vi.fn(),
  ban: vi.fn(),
  unban: vi.fn(),
}));
const admin = vi.hoisted(() => ({ value: true }));
const confirmAnswer = vi.hoisted(() => ({ value: true, asked: [] as string[] }));

vi.mock('$lib/minesweeper/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchMinesweeperLeaderboard: api.leaderboard,
  fetchMinesweeperMe: api.me,
  fetchMinesweeperPromos: api.promos,
  fetchMinesweeperBans: api.bans,
  removeMinesweeperScore: api.remove,
  banMinesweeperUser: api.ban,
  unbanMinesweeperUser: api.unban,
  formatDurationMs: (ms: number) => `${ms}ms`,
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u-1' }));
vi.mock('$lib/components/settings/MinesweeperModal.svelte', () => ({ default: () => {} }));
vi.mock('$lib/stores/userState.svelte', () => ({ globalAdminState: () => admin.value }));
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: async (message: string) => {
    confirmAnswer.asked.push(message);
    return confirmAnswer.value;
  },
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
const ENTRIES = [
  {
    scoreId: 's1',
    rank: 1,
    userId: 'alice',
    displayName: 'Alice',
    durationMs: 41000,
    moveCount: 90,
    verifiedAt: '2026-10-01T10:00:00Z',
  },
  {
    scoreId: 's2',
    rank: 2,
    userId: 'bob',
    displayName: 'Bob',
    durationMs: 52000,
    moveCount: 95,
    verifiedAt: '2026-10-01T10:00:00Z',
  },
];
const BANS = [
  {
    userId: 'mallory',
    displayName: 'Mallory',
    reason: 'cheating',
    bannedBy: 'a',
    bannedAt: '2026-10-02',
  },
];

beforeEach(() => {
  admin.value = true;
  confirmAnswer.value = true;
  confirmAnswer.asked = [];
  api.leaderboard.mockResolvedValue({ entries: ENTRIES, total: ENTRIES.length });
  api.bans.mockResolvedValue(BANS);
  api.me.mockResolvedValue({ personalBestMs: null, rank: null });
  api.promos.mockResolvedValue({ promos: [], mine: null });
  for (const fn of [api.remove, api.ban, api.unban]) fn.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Mounts the page and lets the ranking and the bans load. */
async function openLeaderboard() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.getAttribute('aria-label') === label
  );
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
};

describe('Games page - moderation', () => {
  it('draws the controls for a global admin: a remove and a ban on every row, and the bans', async () => {
    await openLeaderboard();
    expect(button('Retirer ce score')).toHaveLength(2);
    expect(button('Bannir ce joueur')).toHaveLength(2);
    expect(document.body.textContent).toContain('Mallory');
    expect(button('Débannir')).toHaveLength(1);
  });

  it('draws none of it for anyone else, and never asks for the bans', async () => {
    admin.value = false;
    await openLeaderboard();
    expect(button('Retirer ce score')).toHaveLength(0);
    expect(button('Bannir ce joueur')).toHaveLength(0);
    expect(api.bans).not.toHaveBeenCalled();
  });

  it('removes the score of the row it was pressed on, after asking, then refreshes', async () => {
    await openLeaderboard();
    api.leaderboard.mockClear();
    button('Retirer ce score')[1].click();
    await settle();
    expect(confirmAnswer.asked[0]).toContain('Bob');
    expect(api.remove).toHaveBeenCalledExactlyOnceWith('s2');
    expect(api.leaderboard).toHaveBeenCalled();
  });

  it('bans the player of that row, after asking', async () => {
    await openLeaderboard();
    button('Bannir ce joueur')[0].click();
    await settle();
    expect(confirmAnswer.asked[0]).toContain('Alice');
    expect(api.ban).toHaveBeenCalledExactlyOnceWith('alice');
  });

  it('does nothing when the confirmation is refused', async () => {
    confirmAnswer.value = false;
    await openLeaderboard();
    button('Retirer ce score')[0].click();
    button('Bannir ce joueur')[0].click();
    button('Débannir')[0].click();
    await settle();
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.ban).not.toHaveBeenCalled();
    expect(api.unban).not.toHaveBeenCalled();
  });

  it('lifts a ban from the list, after asking', async () => {
    await openLeaderboard();
    button('Débannir')[0].click();
    await settle();
    expect(confirmAnswer.asked[0]).toContain('Mallory');
    expect(api.unban).toHaveBeenCalledExactlyOnceWith('mallory');
  });

  it('says so when an action fails, rather than swallowing it', async () => {
    api.remove.mockRejectedValue(new Error('403'));
    await openLeaderboard();
    button('Retirer ce score')[0].click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("L'action a échoué");
  });
});
