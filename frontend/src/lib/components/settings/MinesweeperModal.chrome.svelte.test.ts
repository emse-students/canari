// @vitest-environment happy-dom
/**
 * MINESWEEPER FULL-SCREEN CHROME (user, 2026-10-07): the board fills the screen and the only
 * visible control besides the HUD is a floating leaderboard button. Pinned: no tab bar, the
 * trophy closes the game and goes to the Games page (the one leaderboard, 2026-11-13), the mode
 * button flips and persists what a short press does, and the close button reaches the host.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const startChallenge = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ goto: vi.fn() }));

vi.mock('$app/navigation', () => ({ goto: nav.goto }));

vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: startChallenge,
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
}));

import MinesweeperModal from './MinesweeperModal.svelte';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const onClose = vi.fn();

beforeEach(() => {
  localStorage.clear();
  onClose.mockReset();
  nav.goto.mockReset();
  startChallenge.mockReset().mockRejectedValue(new Error('no server in this test'));
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
    expect(byLabel('Classement')).toBeDefined();
  });

  it('sends the trophy to the Games page, the one leaderboard, closing the game first', async () => {
    await open();
    byLabel('Classement')!.click();
    flushSync();
    expect(onClose).toHaveBeenCalledOnce();
    expect(nav.goto).toHaveBeenCalledOnce();
    expect(String(nav.goto.mock.calls[0][0])).toContain('/games');
    // No sheet of its own any more: no heading, the board is still the only screen.
    expect(document.querySelector('h2')).toBeNull();
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

  it('plays unranked on request: remembered, and the first dig asks for no challenge', async () => {
    await open();
    const toggle = byText('Classé')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    flushSync();
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
    expect(byText('Libre')!.getAttribute('aria-pressed')).toBe('true');
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    for (let i = 0; i < 6; i++) {
      await flushMacrotask();
      flushSync();
    }
    expect(startChallenge).not.toHaveBeenCalled();
    // A started game keeps its mode.
    expect(byText('Libre')!.disabled).toBe(true);
  });

  it('asks for a challenge when ranked, which is the default', async () => {
    await open();
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    await vi.waitFor(() => expect(startChallenge).toHaveBeenCalledOnce());
  });
});
