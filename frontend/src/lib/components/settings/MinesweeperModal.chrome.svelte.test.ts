// @vitest-environment happy-dom
/**
 * MINESWEEPER FULL-SCREEN CHROME (user, 2026-10-07): the board fills the screen and the only
 * visible control besides the HUD is a floating leaderboard button. Pinned: no tab bar, the
 * trophy and the close button are Back links to the Games page (the one leaderboard, 2026-11-13;
 * the game is a page since 2026-11-25, so leaving it is navigation, never a callback), and the mode
 * button flips and persists what a short press does.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const startChallenge = vi.hoisted(() => vi.fn());

vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: startChallenge,
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
  MinesweeperUpdateRequiredError: class extends Error {},
}));

import MinesweeperModal from './MinesweeperModal.svelte';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  startChallenge.mockReset().mockRejectedValue(new Error('no server in this test'));
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(MinesweeperModal, { target: document.body });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const linkByLabel = (label: string) =>
  document.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`);
const pill = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Mode de la partie"]')!;
const sheetRows = () => [...document.querySelectorAll<HTMLElement>('[data-mode]')];
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
    expect(linkByLabel('Classement')).not.toBeNull();
  });

  it('sends the trophy to the Games page, the one leaderboard, as a Back link', async () => {
    await open();
    const trophy = linkByLabel('Classement')!;
    expect(trophy.getAttribute('href')).toContain('/games');
    // `data-back-link`: the arrow rule returns to the page the player came from instead of stacking one.
    expect(trophy.hasAttribute('data-back-link')).toBe(true);
    // No sheet of its own: no heading, the board is still the only screen.
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

  it('closes through a Back link to the Games page, not a callback', async () => {
    await open();
    const close = linkByLabel('Fermer')!;
    expect(close.getAttribute('href')).toContain('/games');
    expect(close.hasAttribute('data-back-link')).toBe(true);
    expect(byLabel('Fermer')).toBeNull();
  });

  it('starts a newcomer in Libre . Debutant: no challenge on the first dig, and the mode is then locked', async () => {
    await open();
    expect(pill().textContent).toContain('Débutant');
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    for (let i = 0; i < 6; i++) {
      await flushMacrotask();
      flushSync();
    }
    expect(startChallenge).not.toHaveBeenCalled();
    // A started game keeps its mode: the pastille only reminds, and opens nothing.
    expect(pill().disabled).toBe(true);
    pill().click();
    flushSync();
    expect(sheetRows()).toHaveLength(0);
  });

  it('lists the four modes in a sheet, and a pick is remembered: ranked asks for its challenge', async () => {
    await open();
    pill().click();
    flushSync();
    expect(sheetRows().map((r) => r.dataset.mode)).toEqual([
      'ranked',
      'beginner',
      'intermediate',
      'expert',
    ]);
    // The current mode is the checked one, and every mode says what it is.
    expect(sheetRows().find((r) => r.getAttribute('aria-checked') === 'true')?.dataset.mode).toBe(
      'beginner'
    );
    expect(document.body.textContent).toContain("Chrono et classement. Pas d'indice.");
    sheetRows()
      .find((r) => r.dataset.mode === 'ranked')!
      .click();
    flushSync();
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('0');
    expect(pill().textContent).toContain('Classé');
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    await vi.waitFor(() => expect(startChallenge).toHaveBeenCalledOnce());
  });

  it('remembers an unranked level picked in the sheet, and links the tutorial', async () => {
    await open();
    pill().click();
    flushSync();
    sheetRows()
      .find((r) => r.dataset.mode === 'intermediate')!
      .click();
    flushSync();
    expect(localStorage.getItem('canari.minesweeper.level')).toBe('intermediate');
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
    expect(pill().textContent).toContain('Intermédiaire');
    pill().click();
    flushSync();
    expect(
      document.querySelector<HTMLAnchorElement>('a[href*="/games/tutorial"]')?.textContent
    ).toContain('tutoriel');
  });

  it('asks for a challenge when the player chose ranked, and only then', async () => {
    localStorage.setItem('canari.minesweeper.unranked', '0');
    await open();
    expect(pill().textContent).toContain('Classé');
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    await vi.waitFor(() => expect(startChallenge).toHaveBeenCalledOnce());
  });
});
