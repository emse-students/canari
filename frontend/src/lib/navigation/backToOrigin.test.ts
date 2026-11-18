// @vitest-environment happy-dom
/**
 * BACK AFTER A CROSS-SECTION OPEN RETURNS TO THE ORIGIN (owner report, 2026-11-15; review of #3648).
 *
 * One rule decides every arrow: history Back when the page it was reached from is the structural
 * parent or ANOTHER top-level section, and only for an entry a link or goto ADDED; the structural
 * link otherwise. A REPLACE inherits and records nothing, and recording never navigates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ url: new URL('http://x/') }));
vi.mock('$app/state', () => ({ page: route }));
// Recording must never navigate: every navigation API is a spy the tests assert untouched.
const nav = vi.hoisted(() => ({
  goto: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('$app/navigation', () => nav);
const overlays = vi.hoisted(() => ({ depth: 0 }));
vi.mock('$lib/utils/historyOverlayStack', () => ({
  historyOverlayStackDepth: () => overlays.depth,
}));

import { handleAppLinkClick } from '$lib/utils/openExternal';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BACK_LINK_ATTRIBUTE,
  ONE_SHOT_FORM_ROUTES,
  backDecision,
  backLinkTaken,
  recordArrival,
  sectionOf,
} from './backToOrigin';
import { HISTORY_METADATA_KEY, memoryOf, resetEntryMemory } from './historyEntry';

afterEach(() => {
  resetEntryMemory();
  overlays.depth = 0;
  Object.values(nav).forEach((f) => f.mockReset());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Plays one navigation: SvelteKit has written the entry key into `history.state` by `afterNavigate`. */
function go(
  type: 'link' | 'goto' | 'popstate' | 'enter',
  key: number,
  from: string | null,
  to: string
) {
  history.replaceState({ [HISTORY_METADATA_KEY]: { navigationIndex: key } }, '');
  route.url = new URL(`http://x${to}`);
  recordArrival({
    type,
    from: from ? { url: new URL(`http://x${from}`) } : null,
    to: { url: new URL(`http://x${to}`) },
  });
}

describe('sectionOf', () => {
  it('is the first path segment, query and fragment ignored', () => {
    expect(sectionOf('/associations/bde/edit?x=1')).toBe('associations');
    expect(sectionOf('/posts#a')).toBe('posts');
    expect(sectionOf('/')).toBe('');
  });
});

describe('backDecision(current, from, up) - the table of shapes', () => {
  const cases: [string, string, string | undefined, string, 'history' | 'up'][] = [
    ['feed -> association hub', '/associations/humanimines', '/posts', '/associations', 'history'],
    ['feed -> own profile section', '/profile/me/bio', '/posts', '/profile', 'history'],
    ['feed -> event page', '/events/42', '/posts', '/calendar', 'history'],
    ['chat -> post', '/post/9', '/chat', '/posts', 'history'],
    [
      'notification -> association',
      '/associations/bde',
      '/notifications',
      '/associations',
      'history',
    ],
    ['search -> association', '/associations/bde', '/search?q=bde', '/associations', 'history'],
    [
      'post event chip -> association calendar',
      '/associations/bde/calendar?fromPost=7',
      '/posts',
      '/associations/bde',
      'history',
    ],
    ['community mention -> profile', '/profile/u1', '/communities', '/posts', 'history'],
    [
      'association section reached from its hub',
      '/associations/bde/members',
      '/associations/bde',
      '/associations/bde',
      'history',
    ],
    [
      'association hub reached from the directory',
      '/associations/bde',
      '/associations',
      '/associations',
      'history',
    ],
    [
      'hub reached from a sibling section of the same tree',
      '/associations/bde',
      '/associations/other/members',
      '/associations',
      'up',
    ],
    ['cold open / shared link / reload', '/associations/bde', undefined, '/associations', 'up'],
    [
      'a page reached from itself (query change)',
      '/associations/bde',
      '/associations/bde',
      '/associations',
      'up',
    ],
  ];
  it.each(cases)('%s', (_name, current, from, up, expected) => {
    expect(backDecision(current, from, up)).toBe(expected);
  });
});

describe('one-shot forms are declared by route id, never read off the URL (review #2 of #3648)', () => {
  it.each([
    ['/lists/new-list', '/associations/new', '/associations/new', '/lists'],
    ['/forms/abc', '/forms/create', '/forms/create', '/forms'],
    ['/associations/x', '/institutions/new', '/institutions/new', '/associations'],
  ])('a form (%s from %s) is not a destination', (current, from, id, up) => {
    expect(backDecision(current, from, up, id)).toBe('up');
  });

  it('a durable edit hub IS a destination, whatever its URL says', () => {
    expect(
      backDecision(
        '/posts/9',
        '/associations/bde/edit/members',
        '/posts',
        '/associations/[slug]/edit/[[section]]'
      )
    ).toBe('history');
    expect(
      backDecision('/posts/9', '/lists/a/edit', '/posts', '/lists/[slug]/edit/[[section]]')
    ).toBe('history');
  });

  it('a slug named new, edit or create is not a form', () => {
    expect(
      backDecision('/events/1', '/associations/new', '/calendar', '/associations/[slug]')
    ).toBe('history');
    expect(
      backDecision('/events/1', '/associations/edit', '/calendar', '/associations/[slug]')
    ).toBe('history');
  });

  it('every declared id is a route directory that exists', () => {
    for (const id of ONE_SHOT_FORM_ROUTES) {
      expect(existsSync(resolve(__dirname, '../../routes', `.${id}`)), id).toBe(true);
    }
  });

  it('the route id travels from the navigation to the arrow decision', () => {
    history.replaceState({ [HISTORY_METADATA_KEY]: { navigationIndex: 1 } }, '');
    route.url = new URL('http://x/associations/new');
    recordArrival({ type: 'enter', from: null, to: { url: route.url } });
    history.replaceState({ [HISTORY_METADATA_KEY]: { navigationIndex: 2 } }, '');
    route.url = new URL('http://x/lists/mine');
    recordArrival({
      type: 'goto',
      from: { url: new URL('http://x/associations/new'), route: { id: '/associations/new' } },
      to: { url: route.url },
    });
    expect(memoryOf(2)?.fromRouteId).toBe('/associations/new');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    document.body.innerHTML = `<a href="/lists" ${BACK_LINK_ATTRIBUTE}>x</a>`;
    expect(backLinkTaken(document.querySelector('a')!)).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });
});

describe('recording never navigates (a mount-time redirect must not be cancelled)', () => {
  it('calls no navigation API on a push, a replace, a popstate or a first load', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    go('goto', 2, '/associations/bde', '/associations/bde/calendar');
    go('popstate', 1, '/associations/bde/calendar', '/posts');
    expect(Object.values(nav).every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});

describe('what an entry records', () => {
  it('a link that ADDS an entry records the page it left', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    expect(memoryOf(2)?.from).toBe('/posts');
    expect(memoryOf(1)?.from).toBeUndefined();
  });

  it('a first load and a popstate record nothing', () => {
    go('enter', 5, null, '/associations/bde');
    go('popstate', 4, '/associations/bde', '/posts');
    expect(memoryOf(5)?.from).toBeUndefined();
    expect(memoryOf(4)?.from).toBeUndefined();
  });

  it('a push that reuses the key of a discarded forward entry starts from nothing', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/a');
    go('popstate', 1, '/associations/a', '/posts');
    go('link', 2, '/posts', '/lists/b');
    expect(memoryOf(2)?.from).toBe('/posts');
    go('popstate', 1, '/lists/b', '/posts');
    go('link', 2, '/posts', '/profile/u1');
    expect(memoryOf(2)?.from).toBe('/posts');
  });

  it('a shallow navigation records nothing', () => {
    history.replaceState({ [HISTORY_METADATA_KEY]: { navigationIndex: 9 } }, '');
    recordArrival({
      type: 'goto',
      shallow: true,
      from: { url: new URL('http://x/a') },
      to: { url: new URL('http://x/b') },
    });
    expect(memoryOf(9)).toBeUndefined();
  });
});

describe('a REPLACE records nothing and INHERITS (review of #3648, HIGH 2)', () => {
  it('sign-in on a cold deep link: /login replaced by the page leaves the arrow its structural link', () => {
    go('enter', 3, null, '/login');
    go('goto', 3, '/login', '/associations/bde'); // replace: same key
    expect(memoryOf(3)?.from).toBeUndefined();
    expect(backDecision('/associations/bde', memoryOf(3)?.from, '/associations')).toBe('up');
  });

  it('a guard redirect keeps a correct cross-section origin', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    go('goto', 2, '/associations/bde', '/associations/bde/calendar'); // redirect: same key
    expect(memoryOf(2)?.from).toBe('/posts');
  });

  it.each([
    ['error recovery', '/some/error-page', '/posts'],
    ['publish sheet exit', '/camera', '/posts'],
    ['audience redirect', '/posts?feed=x', '/posts'],
    ['lives to posts', '/lives', '/posts'],
  ])('%s: the replaced page never becomes the origin', (_name, replacedPath, landing) => {
    go('enter', 1, null, '/associations/bde');
    go('link', 2, '/associations/bde', replacedPath);
    go('goto', 2, replacedPath, landing);
    expect(memoryOf(2)?.from).toBe('/associations/bde');
    expect(memoryOf(2)?.from).not.toBe(replacedPath);
  });

  it('drops the offset of the page it overwrote', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/lists/x');
    memoryOf(2)!.top = 777;
    go('goto', 2, '/lists/x', '/lists/y');
    expect(memoryOf(2)?.top).toBeUndefined();
  });
});

describe('a Back arrow is answered where every in-app link click is decided', () => {
  function arrow(href: string): HTMLAnchorElement {
    document.body.innerHTML = `<a href="${href}" ${BACK_LINK_ATTRIBUTE}><span>x</span></a>`;
    return document.querySelector('a')!;
  }
  function click(target: Element, over: MouseEventInit = {}) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...over });
    target.dispatchEvent(e);
    handleAppLinkClick(e);
    return e;
  }

  it('walks history for an entry a link added from another section, and cancels the link', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    const e = click(arrow('/associations').querySelector('span')!);
    expect(back).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves the structural link alone for a cold deep link, so the arrow is never dead', () => {
    go('enter', 1, null, '/login');
    go('goto', 1, '/login', '/associations/bde');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    expect(backLinkTaken(arrow('/associations'))).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('leaves the structural link alone while an overlay owns a ghost entry', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    overlays.depth = 1;
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    expect(backLinkTaken(arrow('/associations'))).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('never for a link that is not an arrow, or a modified click', () => {
    go('enter', 1, null, '/posts');
    go('link', 2, '/posts', '/associations/bde');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    document.body.innerHTML = '<a href="/associations"><span>x</span></a>';
    click(document.querySelector('span')!);
    click(arrow('/associations').querySelector('span')!, { ctrlKey: true });
    expect(back).not.toHaveBeenCalled();
  });
});
