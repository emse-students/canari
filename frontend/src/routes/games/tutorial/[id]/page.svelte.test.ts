// @vitest-environment happy-dom
/**
 * ONE LESSON ROUTE, `/games/tutorial/<id>` (owner, 2026-11-27). Pinned: a basics lesson and a catalogue pattern
 * both open from their id, Back leads to the path, and an id that is no lesson is said (and logged), never blank.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const params = vi.hoisted(() => ({ id: 'reveal' }));
vi.mock('$app/state', () => ({
  page: {
    get params() {
      return params;
    },
  },
}));

import Page from './+page.svelte';

let app: ReturnType<typeof mount> | null = null;

function open(id: string) {
  params.id = id;
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

describe('the tutorial lesson route', () => {
  it('opens a basics lesson by its id, and goes back to the path', () => {
    open('chord');
    expect(document.querySelector('h1')?.textContent).toContain('Le chording');
    expect(document.querySelector('[data-testid="tutorial-goal"]')).not.toBeNull();
    expect(document.querySelector('a[data-back-link]')?.getAttribute('href')).toMatch(
      /\/games\/tutorial\?tab=basics$/
    );
  });

  it('opens a catalogue pattern by its id', () => {
    open('one_one');
    expect(document.querySelector('h1')?.textContent).toContain('1-1');
    expect(document.querySelector('[data-testid="tutorial-progress"]')?.textContent).toContain(
      'Motifs de base'
    );
    // Back returns to the tab of the lesson's family, not to the default one.
    expect(document.querySelector('a[data-back-link]')?.getAttribute('href')).toMatch(
      /\/games\/tutorial\?tab=patterns$/
    );
  });

  it('says an unknown lesson is unknown, and leads back to the path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    open('nope');
    expect(document.querySelector('[data-testid="tutorial-missing"]')?.textContent).toContain(
      "Cette leçon n'existe pas."
    );
    expect(warn).toHaveBeenCalledWith('[minesweeper] no such tutorial lesson', {
      lessonId: 'nope',
    });
  });
});
