// @vitest-environment happy-dom
/**
 * THE TUTORIAL'S MINI-GRID (owner, 2026-11-25): the real game in small. Pinned: a tap does what it does in
 * the game (open, flag, chord a number), a mine ends the lesson and says so, the goal ends it and says so
 * ONCE, and the hint lights the numbers it reads and the cells they speak about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
import MinesweeperMiniGrid from './MinesweeperMiniGrid.svelte';

const lessonOf = (id: string) => LESSONS.find((l) => l.id === id)!;
const mounted: Array<() => void> = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function open(id: string, hintStep: number | null = null) {
  const onSolved = vi.fn();
  const onLost = vi.fn();
  const app = mount(MinesweeperMiniGrid, {
    target: document.body,
    props: { lesson: lessonOf(id), hintStep, onSolved, onLost },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return { onSolved, onLost };
}

const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )!;

describe('MinesweeperMiniGrid', () => {
  it('draws the lesson picture: 9 cells for the flag lesson, the numbers open', () => {
    open('flag');
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(9);
    expect(cell(4).textContent?.trim()).toBe('1');
  });

  it('flags on a tap in Drapeau mode, and solves the lesson once', () => {
    const { onSolved, onLost } = open('flag');
    byText('Drapeau').click();
    flushSync();
    cell(8).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
    // A finished lesson ignores further taps: it cannot be solved twice or lost after the fact.
    cell(0).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('flags on a right-click whatever the mode', () => {
    const { onSolved } = open('flag');
    cell(8).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('ends the lesson as lost when a mine is opened', () => {
    const { onSolved, onLost } = open('flag');
    cell(8).click(); // dig mode: the mine
    flushSync();
    expect(onLost).toHaveBeenCalledOnce();
    expect(onSolved).not.toHaveBeenCalled();
  });

  it('chords a number: a tap on the 2 opens what its flags make safe, in either mode', () => {
    const { onSolved } = open('chord');
    byText('Drapeau').click();
    flushSync();
    cell(4).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('lights the numbers a hint reads and the cells they speak about, and only then', async () => {
    open('one_two_one', 0);
    await tick();
    // Step 1: the 2 (ringed) and the three hidden cells under the numbers (tinted).
    expect(cell(1).getAttribute('data-hint')).toBe('hint');
    for (const i of [3, 4, 5]) expect(cell(i).getAttribute('data-hint')).toBe('group');
    expect(cell(0).getAttribute('data-hint')).toBeNull();
  });

  it('shows the gesture target of the guided lesson from the start, without any hint', () => {
    open('reveal');
    expect(cell(0).getAttribute('data-hint')).toBe('group');
  });
});
