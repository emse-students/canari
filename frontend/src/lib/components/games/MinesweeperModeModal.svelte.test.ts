// @vitest-environment happy-dom
/**
 * THE GAME MODE MODAL (owner, 2026-11-27): "Nouvelle partie", centered, two kinds (Classe, Entrainement), the
 * three levels under Entrainement only, "Jouer" commits. Pinned: the kinds and levels, the current mode checked,
 * "Jouer" hands the chosen mode to the caller (and nothing before it), the ways out, the tutorial link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MinesweeperModeModal from './MinesweeperModeModal.svelte';
import { historyOverlayStackDepth, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import type { MinesweeperLevel, PlayMode } from '$lib/minesweeper/levels';

const mounted: Array<() => void> = [];
let stopHistoryStack: () => void;
beforeEach(() => {
  // The listener the root layout installs in the app, and a stubbed traversal (as in Modal.dismissal).
  stopHistoryStack = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
  history.replaceState(null, '');
});
afterEach(() => {
  stopHistoryStack();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function open(current: PlayMode = 'beginner', level: MinesweeperLevel = 'beginner') {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  const onPlay = vi.fn();
  const onClose = vi.fn();
  const app = mount(MinesweeperModeModal, {
    target: document.body,
    props: { current, level, onPlay, onClose, durationMs: 0 },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return { onPlay, onClose };
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-mode]')];
const levels = () => [...document.querySelectorAll<HTMLElement>('[data-level]')];
const checked = (els: HTMLElement[]) =>
  els
    .filter((e) => e.getAttribute('aria-checked') === 'true')
    .map((e) => e.dataset.mode ?? e.dataset.level);
const play = () => document.querySelector<HTMLButtonElement>('[data-testid="mode-play"]')!;

describe('MinesweeperModeModal', () => {
  it('is a centered dialog with two big cards, each saying what it is', () => {
    open();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('h2')?.textContent).toBe('Nouvelle partie');
    expect(cards().map((c) => c.dataset.mode)).toEqual(['ranked', 'training']);
    expect(cards().every((c) => c.getAttribute('role') === 'radio')).toBe(true);
    expect(cards()[0].textContent).toContain('Classé');
    expect(cards()[0].textContent).toContain("Chrono et classement. Pas d'indice.");
    expect(cards()[1].textContent).toContain('Entraînement');
    expect(cards()[1].textContent).toContain("Indices permis, rien n'est compté.");
    expect(document.body.textContent).not.toContain('Libre');
  });

  it('starts on the current mode, and shows the three levels under Entrainement only', () => {
    open('expert', 'expert');
    expect(checked(cards())).toEqual(['training']);
    expect(levels().map((l) => l.dataset.level)).toEqual(['beginner', 'intermediate', 'expert']);
    expect(checked(levels())).toEqual(['expert']);
    document.body.innerHTML = '';
    open('ranked', 'intermediate');
    expect(checked(cards())).toEqual(['ranked']);
    expect(levels()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mode-ranked-note"]')?.textContent).toContain(
      '18 × 32'
    );
  });

  it('hands nothing to the caller until "Jouer", then the chosen mode', () => {
    const { onPlay } = open('beginner', 'beginner');
    levels()
      .find((l) => l.dataset.level === 'intermediate')!
      .click();
    flushSync();
    expect(onPlay).not.toHaveBeenCalled();
    play().click();
    expect(onPlay).toHaveBeenCalledExactlyOnceWith('intermediate');
  });

  it('plays ranked, and a ranked game offers no level', () => {
    const { onPlay } = open();
    cards()
      .find((c) => c.dataset.mode === 'ranked')!
      .click();
    flushSync();
    expect(levels()).toHaveLength(0);
    play().click();
    expect(onPlay).toHaveBeenCalledExactlyOnceWith('ranked');
  });

  it('comes back to Entrainement on the stored level when ranked is left again', () => {
    const { onPlay } = open('ranked', 'expert');
    cards()
      .find((c) => c.dataset.mode === 'training')!
      .click();
    flushSync();
    play().click();
    expect(onPlay).toHaveBeenCalledExactlyOnceWith('expert');
  });

  it('closes on Escape, on the scrim and on the cross, choosing nothing', () => {
    const { onClose, onPlay } = open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    document
      .querySelector<HTMLElement>('[data-testid="mode-modal"] > [role="presentation"]')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(2);
    document.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]')!.click();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('closes on the Android Back key, like every overlay: it takes a history entry, so Back never leaves the game (reading item 13)', () => {
    const { onClose, onPlay } = open();
    expect(historyOverlayStackDepth()).toBe(1);
    // The event a WebView delivers when the physical Back button is pressed.
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('releases its history entry when it closes by Escape, by Jouer or when it goes', () => {
    open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(historyOverlayStackDepth()).toBe(0);
    document.body.innerHTML = '';
    while (mounted.length) mounted.pop()!();
    open();
    expect(historyOverlayStackDepth()).toBe(1);
    while (mounted.length) mounted.pop()!();
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('says where to change later, and links the tutorial', () => {
    open();
    expect(document.body.textContent).toContain(
      'Tu pourras changer ensuite depuis la pastille en bas.'
    );
    expect(document.querySelector('a[href*="/games/tutorial"]')?.textContent).toContain('tutoriel');
  });
});
