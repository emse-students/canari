// @vitest-environment happy-dom
/**
 * THE PATTERN CATALOGUE PAGE (the tutorial's annex, owner 2026-11-26). Pinned: it opens on the first pattern
 * under its family, counts patterns (not lessons), offers a jump list, walks the entries with their hints
 * to a closing screen, and leads back to the tutorial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { PATTERNS } from '$lib/minesweeper/tutorial/patterns';
import { FLAG_PRIMARY_STORAGE_KEY } from '$lib/minesweeper/controls';
import Page from './+page.svelte';

let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // The gestures were chosen already: the first-time choice has its own test.
  localStorage.setItem(FLAG_PRIMARY_STORAGE_KEY, '0');
  app = mount(Page, { target: document.body });
  flushSync();
});
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )!;
const testId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const next = () => {
  byText('Leçon suivante').click();
  flushSync();
};

describe('the pattern catalogue page', () => {
  it('opens on the first pattern, under its family, and counts patterns', () => {
    const progress = testId('tutorial-progress')?.textContent ?? '';
    expect(progress).toContain(PATTERNS[0].section!());
    expect(progress).toContain(`Pattern 1 sur ${PATTERNS.length}`);
    expect(document.querySelector('h2')?.textContent).toContain(PATTERNS[0].title());
  });

  it('links back to the tutorial it is the annex of', () => {
    expect(document.querySelector('a[data-back-link]')?.getAttribute('href')).toContain(
      '/games/tutorial'
    );
  });

  it('offers a jump to any pattern, since a catalogue is not read in order', () => {
    expect(document.body.textContent).toContain('Aller à un pattern');
  });

  it('walks a pattern hint by hint with its legend', async () => {
    // The 4th entry is the first one the tutorial does not teach: a generated board.
    for (let i = 0; i < 3; i++) next();
    byText('Indice').click();
    flushSync();
    await tick();
    expect(testId('tutorial-hint')?.textContent?.length).toBeGreaterThan(0);
    expect(testId('tutorial-legend')).not.toBeNull();
  });

  it('chains every pattern to a closing screen that leads to a game', () => {
    for (let i = 0; i < PATTERNS.length; i++) next();
    expect(testId('patterns-finish')).not.toBeNull();
    expect(byText('Jouer une partie').getAttribute('href')).toContain('/games/play');
  });
});
