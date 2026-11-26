// @vitest-environment happy-dom
/**
 * THE MODE SHEET (owner, 2026-11-26): ONE list of four, each with its line, replacing the Classe / Libre
 * toggle and the cycling level chip. Pinned: the four modes in order, the current one checked, a pick
 * reaches the caller, the way out (Escape, the scrim, the close button), and the tutorial link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MinesweeperModeSheet from './MinesweeperModeSheet.svelte';
import type { PlayMode } from '$lib/minesweeper/levels';

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function open(current: PlayMode = 'beginner') {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  const app = mount(MinesweeperModeSheet, {
    target: document.body,
    props: { current, onChoose, onClose, durationMs: 0 },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return { onChoose, onClose };
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-mode]')];

describe('MinesweeperModeSheet', () => {
  it('lists the four modes in a radio group, each with a line on what it is', () => {
    open();
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(rows().map((r) => r.dataset.mode)).toEqual([
      'ranked',
      'beginner',
      'intermediate',
      'expert',
    ]);
    expect(rows().every((r) => r.getAttribute('role') === 'radio')).toBe(true);
    const text = rows().map((r) => r.textContent ?? '');
    expect(text[0]).toContain('Classé');
    expect(text[0]).toContain("Pas d'indice");
    expect(text[1]).toContain('Libre · Débutant');
    expect(text[3]).toContain('Libre · Expert');
  });

  it('checks the current mode, and only that one', () => {
    open('ranked');
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
  });

  it('hands a pick to the caller', () => {
    const { onChoose } = open();
    rows()
      .find((r) => r.dataset.mode === 'expert')!
      .click();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('expert');
  });

  it('closes on Escape, on the scrim and on the close button', () => {
    const { onClose } = open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    document
      .querySelector<HTMLElement>('[data-testid="mode-sheet"] > [role="presentation"]')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(2);
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Fermer')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('is a dialog, and links the tutorial', () => {
    open();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('a[href*="/games/tutorial"]')?.textContent).toContain('tutoriel');
  });
});
