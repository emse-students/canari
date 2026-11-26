// @vitest-environment happy-dom
/**
 * THE TUTORIAL PAGE (owner, 2026-11-25). Pinned: it opens on the first lesson, the hint button walks the
 * lesson's steps and then hides them, solving a lesson says so, a mine says so and a restart plays it
 * again, the lessons chain up to a closing screen that leads to a game, and Back leads to the Games page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
import Page from './+page.svelte';

let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  app = mount(Page, { target: document.body });
  flushSync();
});
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )!;
const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const testId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const next = () => {
  byText('Leçon suivante').click();
  flushSync();
};

describe('the tutorial page', () => {
  it('opens on the first lesson and links back to the Games page', () => {
    expect(testId('tutorial-progress')?.textContent).toContain(`1 sur ${LESSONS.length}`);
    expect(document.querySelector('h2')?.textContent).toContain(LESSONS[0].title());
    expect(document.querySelector('a[data-back-link]')?.getAttribute('href')).toContain('/games');
  });

  it('walks the hint steps, then hides them', async () => {
    next(); // the flag lesson has two steps
    expect(testId('tutorial-hint')).toBeNull();
    byText('Indice').click();
    flushSync();
    await tick();
    expect(testId('tutorial-hint')?.textContent).toContain(
      "Ce 1 ne touche qu'une seule case cachée"
    );
    byText('Indice suivant').click();
    flushSync();
    expect(testId('tutorial-hint')?.textContent).toContain('Cette case est donc une mine sûre');
    // The colours are explained once the hint is up, and only then.
    expect(testId('tutorial-legend')?.textContent).toContain('Mine sûre');
    expect(testId('tutorial-legend')?.textContent).toContain('Case sûre');
    byText("Masquer l'indice").click();
    flushSync();
    expect(testId('tutorial-hint')).toBeNull();
    expect(testId('tutorial-legend')).toBeNull();
  });

  it('says a lesson is solved, and a mine is a mine; restart plays it again', () => {
    next(); // flag lesson: the mine is the bottom-right cell
    cell(8).click();
    flushSync();
    expect(testId('tutorial-lost')).not.toBeNull();
    byText('Recommencer').click();
    flushSync();
    expect(testId('tutorial-lost')).toBeNull();
    byText('Drapeau').click();
    flushSync();
    cell(8).click();
    flushSync();
    expect(testId('tutorial-solved')).not.toBeNull();
  });

  it('chains the lessons to a closing screen that leads to a game', () => {
    for (let i = 0; i < LESSONS.length; i++) next();
    expect(testId('tutorial-finish')).not.toBeNull();
    expect(byText('Jouer une partie').getAttribute('href')).toContain('/games/play');
    byText('Recommencer').click();
    flushSync();
    expect(testId('tutorial-progress')?.textContent).toContain(`1 sur ${LESSONS.length}`);
  });

  it('leads to the pattern catalogue, its annex, from the header and from the closing screen', () => {
    const links = () =>
      [...document.querySelectorAll<HTMLAnchorElement>('a')].filter((a) =>
        a.getAttribute('href')?.includes('/games/tutorial/patterns')
      );
    expect(links()).toHaveLength(1);
    for (let i = 0; i < LESSONS.length; i++) next();
    expect(links().length).toBe(2);
  });

  it('goes back a lesson', () => {
    next();
    byText('Leçon précédente').click();
    flushSync();
    expect(testId('tutorial-progress')?.textContent).toContain(`1 sur ${LESSONS.length}`);
  });
});
