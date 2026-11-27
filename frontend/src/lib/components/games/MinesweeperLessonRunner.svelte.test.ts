// @vitest-environment happy-dom
/**
 * ONE LESSON SCREEN (owner, 2026-11-27). Pinned: Le Pic and his bubble (the goal, then each step of the lamp,
 * his mood following), the miner's lamp (a label, the step dots, a pulse until first used and none after, and
 * none at all under reduced motion by CSS), the legend, restart, a mine, solving ONCE and recording it, the
 * solved screen (the flag, the family progress, the next lesson, back to the path) and "Passer".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
import { PATTERNS } from '$lib/minesweeper/tutorial/patterns';
import { locateLesson } from '$lib/minesweeper/tutorial/path';
import { TUTORIAL_PROGRESS_KEY, loadTutorialProgress } from '$lib/minesweeper/tutorial/progress';
import MinesweeperLessonRunner from './MinesweeperLessonRunner.svelte';

let app: ReturnType<typeof mount> | null = null;

function open(id: string) {
  app = mount(MinesweeperLessonRunner, {
    target: document.body,
    props: { place: locateLesson(id)! },
  });
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const testId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lamp = () => testId('tutorial-lamp')!;
const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const pic = () => document.querySelector<SVGElement>('svg[data-pose]')!;
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )!;
const press = async (el: HTMLElement) => {
  el.click();
  flushSync();
  await tick();
};

describe('a lesson screen', () => {
  it('says the goal first, with Le Pic thinking, and shows the family position', () => {
    open('reveal');
    expect(testId('tutorial-goal')?.textContent).toContain('Touche la case entourée en vert');
    expect(pic().dataset.mood).toBe('think');
    expect(pic().dataset.pose).toBe('rest');
    expect(testId('tutorial-progress')?.textContent).toContain(`1 / ${LESSONS.length}`);
  });

  it('walks the lamp: each step in the bubble, Le Pic pointing, glad on the last, then hides', async () => {
    open('flag'); // two steps
    expect(lamp().getAttribute('aria-label')).toBe('Indice');
    await press(lamp());
    expect(testId('tutorial-hint')?.textContent).toContain(
      "Ce 1 ne touche qu'une seule case cachée"
    );
    expect(document.body.textContent).toContain('Indice 1 / 2');
    expect(pic().dataset.pose).toBe('point');
    expect(pic().dataset.mood).toBe('neutral');
    expect(lamp().getAttribute('aria-label')).toBe('Indice suivant');
    await press(lamp());
    expect(testId('tutorial-hint')?.textContent).toContain('Cette case est donc une mine sûre');
    expect(pic().dataset.mood).toBe('happy');
    expect(lamp().getAttribute('aria-label')).toBe("Masquer l'indice");
    await press(lamp());
    expect(testId('tutorial-hint')).toBeNull();
    expect(testId('tutorial-goal')).not.toBeNull();
    expect(pic().dataset.pose).toBe('rest');
  });

  it('lights the lamp while a hint is shown, with one dot per step', async () => {
    open('flag');
    expect(lamp().querySelector('svg[data-lit]')?.getAttribute('data-lit')).toBe('false');
    expect(lamp().querySelectorAll('span.rounded-full')).toHaveLength(2);
    await press(lamp());
    expect(lamp().querySelector('svg[data-lit]')?.getAttribute('data-lit')).toBe('true');
  });

  it('pulses the lamp until it was used once on this device, and never again', async () => {
    open('flag');
    const disc = () => lamp().querySelector('.lamp-button')!;
    expect(disc().classList.contains('lamp-pulse')).toBe(true);
    await press(lamp());
    expect(disc().classList.contains('lamp-pulse')).toBe(false);
    expect(loadTutorialProgress().lampUsed).toBe(true);
    // Another lesson, later: it stays still.
    unmount(app!, { outro: false });
    document.body.innerHTML = '';
    open('chord');
    expect(lamp().querySelector('.lamp-button')!.classList.contains('lamp-pulse')).toBe(false);
  });

  it('explains the three colours under the grid, always', () => {
    open('flag');
    expect(testId('tutorial-legend')?.textContent).toContain('Mine sûre');
    expect(testId('tutorial-legend')?.textContent).toContain('Groupe de cases');
    expect(testId('tutorial-legend')?.textContent).toContain('Case sûre');
  });

  it('says a mine is a mine, with Le Pic worried; restart plays it again', async () => {
    open('flag'); // the mine is the bottom-right cell
    await press(cell(8));
    expect(testId('tutorial-lost')).not.toBeNull();
    expect(pic().dataset.mood).toBe('worried');
    await press(byText('Recommencer'));
    expect(testId('tutorial-lost')).toBeNull();
    expect(pic().dataset.mood).toBe('think');
  });

  it('records a solved lesson ONCE and shows the solved screen: the flag, the progress, the next lesson', async () => {
    open('flag');
    await press(byText('Drapeau'));
    await press(cell(8));
    expect(testId('tutorial-solved')).not.toBeNull();
    expect(loadTutorialProgress().done).toEqual(['flag']);
    expect(pic().dataset.pose).toBe('flag');
    expect(testId('tutorial-solved')?.textContent).toContain('Leçon réussie !');
    expect(testId('tutorial-solved-progress')?.textContent?.trim()).toBe(`1 / ${LESSONS.length}`);
    expect(testId('tutorial-solved-next')?.getAttribute('href')).toContain(
      `/games/tutorial/${LESSONS[2].id}`
    );
    expect(byText('Retour au parcours').getAttribute('href')).toContain('/games/tutorial');
    expect(JSON.parse(localStorage.getItem(TUTORIAL_PROGRESS_KEY)!).done).toEqual(['flag']);
  });

  it('says "Motif maitrise" for a pattern, with the pattern name and the next one', async () => {
    const first = PATTERNS[0];
    const place = locateLesson(first.id)!;
    app = mount(MinesweeperLessonRunner, { target: document.body, props: { place } });
    flushSync();
    // Solve it the way a player does: open what the lesson asks, flag what it asks.
    const board = first.goal;
    for (const [x, y] of board.reveal) await press(cell(y * first.rows[0].length + x));
    await press(byText('Drapeau'));
    for (const [x, y] of board.flag) await press(cell(y * first.rows[0].length + x));
    expect(testId('tutorial-solved')?.textContent).toContain('Motif maîtrisé !');
    expect(testId('tutorial-solved-name')?.textContent?.trim()).toBe('B1');
    expect(testId('tutorial-solved-next')?.textContent).toContain('Motif suivant ·');
    expect(testId('tutorial-solved-next')?.getAttribute('href')).toContain(PATTERNS[1].id);
    expect(byText('Retour au parcours').getAttribute('href')).toMatch(/\?tab=patterns$/);
  });

  it('skips without recording: "Passer" leads to the next lesson, and the path at the end', () => {
    open('reveal');
    expect(testId('tutorial-skip')?.getAttribute('href')).toContain(
      `/games/tutorial/${LESSONS[1].id}`
    );
    expect(loadTutorialProgress().done).toEqual([]);
    unmount(app!, { outro: false });
    document.body.innerHTML = '';
    open(LESSONS.at(-1)!.id);
    expect(testId('tutorial-skip')?.getAttribute('href')).toMatch(/\/games\/tutorial\?tab=basics$/);
  });
});

describe('the bottom bar and the tab bar', () => {
  it('sticks above the shell measure of the tab bar, never a hard-coded offset (iPhone reading, 2026-11-27)', () => {
    open('flag');
    const cls = testId('tutorial-bottom-bar')!.className;
    expect(cls).toContain('sticky');
    expect(cls).toContain('bottom-(--bottom-nav-reserve)');
    // No literal rem/px bottom offset competes with the measure.
    expect(cls).not.toMatch(/(^|\s)bottom-(\d|\[)/);
    // Its three controls are all inside the bar, so none can sit under the tab bar.
    const bar = testId('tutorial-bottom-bar')!;
    expect(bar.contains(testId('tutorial-lamp'))).toBe(true);
    expect(bar.contains(testId('tutorial-skip'))).toBe(true);
    expect(bar.textContent).toContain('Recommencer');
  });
});
