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
const nav = vi.hoisted(() => ({ url: new URL('http://localhost/games/tutorial') }));
const gotoMock = vi.hoisted(() => vi.fn());
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return nav.url;
    },
    state: {},
  },
}));
vi.mock('$app/navigation', () => ({
  goto: (href: string, opts: unknown) => {
    gotoMock(href, opts);
    nav.url = new URL(href, 'http://localhost');
    return Promise.resolve();
  },
}));

import Page from './+page.svelte';

let app: ReturnType<typeof mount> | null = null;

function open() {
  app = mount(Page, { target: document.body });
  flushSync();
}

beforeEach(() => {
  nav.url = new URL('http://localhost/games/tutorial');
  gotoMock.mockReset();
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

  it('keeps the active tab in the URL: a tab change writes ?tab=, and a URL with it opens on that tab', () => {
    open();
    tab('Motifs').click();
    flushSync();
    expect(gotoMock).toHaveBeenCalledTimes(1);
    expect(gotoMock.mock.calls[0][0]).toContain('tab=patterns');
    expect(gotoMock.mock.calls[0][1]).toMatchObject({ replace: true, shallow: true });
    unmount(app!, { outro: false });
    document.body.innerHTML = '';
    nav.url = new URL('http://localhost/games/tutorial?tab=patterns');
    open();
    expect(tab('Motifs').getAttribute('aria-selected')).toBe('true');
  });
});

describe('the path follows the design (owner, 2026-11-28)', () => {
  it('has the short header, and the path runs upward without moving the DOM order', () => {
    store([]);
    open();
    expect(document.querySelector('h1')?.textContent?.trim()).toBe('Apprendre');
    expect(document.querySelector('[data-testid="path-stack"]')?.className).toContain(
      'flex-col-reverse'
    );
    expect(document.querySelector('[data-testid="path-family"] ol')?.className).toContain(
      'flex-col-reverse'
    );
    // The first lesson is still the first tile in the DOM and in the tab order.
    expect(tiles()[0].dataset.lesson).toBe(LESSONS[0].id);
  });

  it('draws the scenery as decoration only', () => {
    open();
    const scenery = document.querySelectorAll('[data-testid="path-stack"] > svg');
    expect(scenery).toHaveLength(2);
    for (const svg of scenery) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('puts a catalogue button beside a GREEN "Continuer", and the catalogue opens the Motifs tab', () => {
    store([]);
    open();
    expect(continueButton().className).toContain('bg-green-solid');
    const catalogue = document.querySelector<HTMLButtonElement>(
      '[data-testid="tutorial-catalogue"]'
    )!;
    expect(catalogue.getAttribute('aria-label')).toBe('Catalogue des motifs');
    catalogue.click();
    flushSync();
    expect(tab('Motifs').getAttribute('aria-selected')).toBe('true');
  });

  it('marks a complete "Les bases" tab with a check, and only then', () => {
    store([]);
    open();
    expect(tab('Les bases').querySelector('svg')).toBeNull();
    document.body.innerHTML = '';
    store(LESSONS.map((l) => l.id));
    open();
    expect(tab('Les bases').querySelector('svg')).not.toBeNull();
  });
});
