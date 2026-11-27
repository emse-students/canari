// @vitest-environment happy-dom
/**
 * MINESWEEPER FULL-SCREEN CHROME (user, 2026-10-07): the board fills the screen and the only
 * visible control besides the HUD is a floating leaderboard button. Pinned: no tab bar, the
 * trophy and the close button are Back links to the Games page (the one leaderboard, 2026-11-13;
 * the game is a page since 2026-11-25, so leaving it is navigation, never a callback), and the mode
 * button flips and persists what a short press does, and the mode modal (owner, 2026-11-27) opens by itself at
 * the first game on a device and afterwards from the pastille.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
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
  // A RETURNING player: a mode is stored, so the mode modal does not open by itself. The first-game tests clear it.
  localStorage.setItem('canari.minesweeper.unranked', '1');
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
const modal = () => document.querySelector<HTMLElement>('[data-testid="mode-modal"]');
const kindCards = () => [...document.querySelectorAll<HTMLElement>('[data-mode]')];
const levelPills = () => [...document.querySelectorAll<HTMLElement>('[data-level]')];
const play = () => document.querySelector<HTMLButtonElement>('[data-testid="mode-play"]')!;
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

  it('opens the mode modal BY ITSELF at the first game, with Entrainement on Debutant as the default', async () => {
    localStorage.removeItem('canari.minesweeper.unranked');
    await open();
    expect(modal()).not.toBeNull();
    expect(modal()!.textContent).toContain('Nouvelle partie');
    expect(kindCards().map((c) => c.dataset.mode)).toEqual(['ranked', 'training']);
    expect(kindCards().find((c) => c.getAttribute('aria-checked') === 'true')?.dataset.mode).toBe(
      'training'
    );
    expect(levelPills().map((l) => l.dataset.level)).toEqual([
      'beginner',
      'intermediate',
      'expert',
    ]);
    expect(levelPills().find((l) => l.getAttribute('aria-checked') === 'true')?.dataset.level).toBe(
      'beginner'
    );
    expect(modal()!.textContent).toContain("Chrono et classement. Pas d'indice.");
    expect(modal()!.textContent).toContain("Indices permis, rien n'est compté.");
    expect(modal()!.textContent).toContain('Tu pourras changer ensuite depuis la pastille en bas.');
    expect(pill().textContent).toContain('Débutant');
  });

  it('closes on the Android Back key and the game stays (reading item 13): the pastille modal and the first-game one', async () => {
    const stop = initHistoryOverlayStack();
    vi.spyOn(history, 'back').mockImplementation(() => {});
    try {
      localStorage.removeItem('canari.minesweeper.unranked');
      await open();
      expect(modal()).not.toBeNull();
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      flushSync();
      await vi.waitFor(() => expect(modal()).toBeNull());
      // The game is still on screen, and the dismissal kept the default like Escape does.
      expect(document.querySelectorAll('[data-cell]')).toHaveLength(18 * 32);
      expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
      pill().click();
      flushSync();
      expect(modal()).not.toBeNull();
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      flushSync();
      await vi.waitFor(() => expect(modal()).toBeNull());
    } finally {
      stop();
    }
  });

  it('does NOT open by itself once a mode is stored: the pastille opens it', async () => {
    await open();
    expect(modal()).toBeNull();
    pill().click();
    flushSync();
    expect(modal()).not.toBeNull();
  });

  it('keeps the default and stores it when the first-game modal is dismissed, so it never nags', async () => {
    localStorage.removeItem('canari.minesweeper.unranked');
    await open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    await tick();
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
    expect(pill().textContent).toContain('Débutant');
    // The next mount is a returning player's: no modal by itself.
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    await open();
    expect(modal()).toBeNull();
  });

  it('plays unranked at the first game with no challenge, and the mode is then locked', async () => {
    localStorage.removeItem('canari.minesweeper.unranked');
    await open();
    play().click();
    flushSync();
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
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
    await vi.waitFor(() => expect(modal()).toBeNull());
  });

  it('offers the two kinds and, under Entrainement only, the three levels; a pick writes the stored settings and ranked asks for its challenge', async () => {
    await open();
    pill().click();
    flushSync();
    expect(levelPills()).toHaveLength(3);
    kindCards()
      .find((c) => c.dataset.mode === 'ranked')!
      .click();
    flushSync();
    // The levels belong to Entrainement: Classe has none.
    expect(levelPills()).toHaveLength(0);
    // Nothing is stored until "Jouer".
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
    play().click();
    flushSync();
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('0');
    expect(pill().textContent).toContain('Classé');
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    await vi.waitFor(() => expect(startChallenge).toHaveBeenCalledOnce());
  });

  it('remembers an Entrainement level picked in the modal, and links the tutorial', async () => {
    await open();
    pill().click();
    flushSync();
    levelPills()
      .find((l) => l.dataset.level === 'intermediate')!
      .click();
    flushSync();
    play().click();
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
