/**
 * MINESWEEPER FULL-SCREEN CHROME (user, 2026-10-07): the board fills the screen and the only
 * visible control besides the HUD is a floating leaderboard button. Pinned: no tab bar, the
 * leaderboard is a sheet that opens and closes over the game, the mode button flips and persists
 * what a short press does, and the close button reaches the host.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

vi.mock('$lib/minesweeper/api', () => ({
  fetchMinesweeperLeaderboard: vi.fn().mockResolvedValue([]),
  fetchMinesweeperBans: vi.fn().mockResolvedValue([]),
  removeMinesweeperScore: vi.fn(),
  banMinesweeperUser: vi.fn(),
  unbanMinesweeperUser: vi.fn(),
  startMinesweeperChallenge: vi.fn(),
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
}));
vi.mock('$lib/stores/userState.svelte', () => ({ globalAdminState: () => false }));

import MinesweeperModal from './MinesweeperModal.svelte';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const onClose = vi.fn();

beforeEach(() => {
  localStorage.clear();
  onClose.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(MinesweeperModal, { target: document.body, props: { open: true, onClose } });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );

describe('MinesweeperModal - full-screen chrome', () => {
  it('has no tab bar and no title bar: the board and floating controls only', async () => {
    await open();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(18 * 32);
    expect(byText('Classement')).toBeDefined();
  });

  it('opens the leaderboard as a sheet over the game and goes back to it', async () => {
    await open();
    byText('Classement')!.click();
    flushSync();
    expect(document.querySelector('h2')?.textContent).toContain('Classement');
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(18 * 32);
    byLabel('Retour à la partie')!.click();
    flushSync();
    // The sheet fades out before it leaves the DOM.
    await vi.waitFor(() => expect(document.querySelector('h2')).toBeNull(), { timeout: 2000 });
  });

  it('flips what a short press does from the mode button, and remembers it', async () => {
    await open();
    const dig = byText('Miner')!;
    expect(dig.getAttribute('aria-pressed')).toBe('false');
    dig.click();
    flushSync();
    expect(byText('Drapeau')!.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('canari.minesweeper.flagPrimary')).toBe('1');
  });

  it('hands the close to its host', async () => {
    await open();
    byLabel('Fermer')!.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
