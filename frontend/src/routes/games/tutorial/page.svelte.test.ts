// @vitest-environment happy-dom
/**
 * THE TUTORIAL PATH PAGE (owner, 2026-11-27). Pinned: two tabs with their progress, a tile per lesson in
 * path order, EVERYTHING OPEN (every tile is a link, whatever is done), done / current / todo read from the
 * device's storage, an invalid stored value logged and ignored, the family progress and the "Continue" button
 * to the first lesson not done, and Back to `/games`. No streak, no flame, no medal, no points.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
import { PATTERNS } from '$lib/minesweeper/tutorial/patterns';
import { TUTORIAL_PROGRESS_KEY } from '$lib/minesweeper/tutorial/progress';
import Page from './+page.svelte';

let app: ReturnType<typeof mount> | null = null;

function open() {
  app = mount(Page, { target: document.body });
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

const tiles = () => [...document.querySelectorAll<HTMLAnchorElement>('a[data-lesson]')];
const tile = (id: string) => document.querySelector<HTMLAnchorElement>(`a[data-lesson="${id}"]`)!;
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.trim().startsWith(name)
  )!;
const continueButton = () =>
  document.querySelector<HTMLAnchorElement>('[data-testid="tutorial-continue"] a')!;
const store = (done: string[]) =>
  localStorage.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify({ done, lampUsed: false }));

describe('the tutorial path page', () => {
  it('opens on the basics, with one tile per lesson, in order, and links back to the Games page', () => {
    open();
    expect(tab('Les bases').getAttribute('aria-selected')).toBe('true');
    expect(tiles().map((t) => t.dataset.lesson)).toEqual(LESSONS.map((l) => l.id));
    expect(document.querySelector('a[data-back-link]')?.getAttribute('href')).toContain('/games');
  });

  it('shows the progress of each tab in its label', () => {
    store([LESSONS[0].id, PATTERNS[0].id, PATTERNS[1].id]);
    open();
    expect(tab('Les bases').textContent).toContain(`1 / ${LESSONS.length}`);
    expect(tab('Motifs').textContent).toContain(`2 / ${PATTERNS.length}`);
  });

  it('draws the patterns under the headings of their families', () => {
    open();
    tab('Motifs').click();
    flushSync();
    expect(tiles().map((t) => t.dataset.lesson)).toEqual(PATTERNS.map((p) => p.id));
    const headings = [...document.querySelectorAll('[data-testid="path-family"] h2')].map((h) =>
      h.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(headings).toHaveLength(6);
    expect(headings[0]).toBe('Motifs de base 0 / 10');
  });

  it('keeps EVERYTHING OPEN: every tile is a link to its lesson, done or not, advised order or not', () => {
    store([LESSONS[2].id]);
    open();
    for (const lesson of LESSONS) {
      expect(tile(lesson.id).getAttribute('href')).toContain(`/games/tutorial/${lesson.id}`);
      expect(tile(lesson.id).hasAttribute('disabled')).toBe(false);
      expect(tile(lesson.id).getAttribute('aria-disabled')).toBeNull();
    }
  });

  it('reads done and current from the storage: done is checked, the first not done is the current one', () => {
    store([LESSONS[0].id, LESSONS[1].id]);
    open();
    expect(tiles().map((t) => t.dataset.state)).toEqual([
      'done',
      'done',
      'current',
      'todo',
      'todo',
    ]);
    expect(tile(LESSONS[0].id).getAttribute('aria-label')).toContain('fait');
    expect(tile(LESSONS[0].id).querySelector('svg')).not.toBeNull();
    expect(tile(LESSONS[2].id).getAttribute('aria-label')).toContain('prochaine étape');
    // Le Pic stands on the current tile, and only there.
    expect(document.querySelectorAll('li svg[data-pose]')).toHaveLength(1);
    expect(tile(LESSONS[2].id).closest('li')?.querySelector('svg[data-pose]')).not.toBeNull();
  });

  it('does not lock a lesson that comes after the current one', () => {
    store([]);
    open();
    expect(tile(LESSONS[4].id).dataset.state).toBe('todo');
    expect(tile(LESSONS[4].id).getAttribute('href')).toContain(LESSONS[4].id);
  });

  it('leads "Continue" to the first lesson not done, with the progress of its family', () => {
    store([LESSONS[0].id, LESSONS[1].id]);
    open();
    expect(continueButton().textContent?.trim()).toMatch(/^Continuer · /);
    expect(continueButton().getAttribute('href')).toContain(`/games/tutorial/${LESSONS[2].id}`);
    const summary = document.querySelector('[data-testid="tutorial-continue"]')!;
    expect(summary.textContent).toContain(`2 / ${LESSONS.length}`);
    const bar = summary.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(LESSONS.length));
  });

  it('opens on the patterns once the basics are done, and offers a game when a tab is complete', () => {
    store(LESSONS.map((l) => l.id));
    open();
    expect(tab('Motifs').getAttribute('aria-selected')).toBe('true');
    expect(continueButton().getAttribute('href')).toContain(PATTERNS[0].id);
    tab('Les bases').click();
    flushSync();
    expect(continueButton().getAttribute('href')).toContain('/games/play');
  });

  it('logs and ignores a stored value that is not valid: the path starts blank', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(TUTORIAL_PROGRESS_KEY, '{"done": 7}');
    open();
    expect(warn).toHaveBeenCalled();
    expect(tiles().map((t) => t.dataset.state)).toEqual([
      'current',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('has no streak, flame, medal or points: a tutorial and its levels', () => {
    store([LESSONS[0].id]);
    open();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/série|streak|flamme|médaille|medal|points?\b|xp/i);
    expect(document.querySelector('svg.lucide-flame')).toBeNull();
  });
});
