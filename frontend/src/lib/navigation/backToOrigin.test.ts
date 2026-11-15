// @vitest-environment happy-dom
/**
 * BACK AFTER A CROSS-SECTION OPEN RETURNS TO THE ORIGIN (owner report, 2026-11-15).
 *
 * One rule decides every arrow: history Back when the page it was reached from is the structural
 * parent or ANOTHER top-level section; the structural link otherwise. Each row below is a real
 * shape of the table in `docs/wiki/frontend/section-navigation.md`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  page: { url: new URL('http://x/'), state: {} as { from?: string } },
}));
const goto = vi.hoisted(() => vi.fn(async (_to: string, _opts?: unknown) => {}));
vi.mock('$app/state', () => state);
vi.mock('$app/navigation', () => ({ goto }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleAppLinkClick } from '$lib/utils/openExternal';
import {
  BACK_LINK_ATTRIBUTE,
  backDecision,
  backLinkTaken,
  recordArrival,
  sectionOf,
} from './backToOrigin';

afterEach(() => {
  goto.mockClear();
  state.page.state = {};
  vi.restoreAllMocks();
});

describe('sectionOf', () => {
  it('is the first path segment, query and fragment ignored', () => {
    expect(sectionOf('/associations/bde/edit?x=1')).toBe('associations');
    expect(sectionOf('/posts#a')).toBe('posts');
    expect(sectionOf('/')).toBe('');
  });
});

describe('backDecision(current, from, up)', () => {
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
    ['communities mention -> profile', '/profile/u1', '/communities', '/posts', 'history'],
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

function nav(
  type: string,
  opts: { from?: string; to?: string; shallow?: boolean } = {}
): Parameters<typeof recordArrival>[0] {
  return {
    type,
    shallow: opts.shallow,
    from: { url: new URL(opts.from ?? 'http://x/posts') },
    to: { url: new URL(opts.to ?? 'http://x/associations/bde') },
  };
}

describe('recordArrival stamps the entry with the page it left', () => {
  it('on a link and on a goto', () => {
    recordArrival(nav('link'));
    expect(goto).toHaveBeenCalledWith('/associations/bde', {
      shallow: true,
      replace: true,
      state: { from: '/posts' },
    });
    recordArrival(nav('goto', { from: 'http://x/chat?c=1' }));
    expect(goto).toHaveBeenLastCalledWith('/associations/bde', {
      shallow: true,
      replace: true,
      state: { from: '/chat?c=1' },
    });
  });
  it.each(['popstate', 'enter', 'leave'])(
    'never on %s (the entry already holds its state)',
    (type) => {
      recordArrival(nav(type));
      expect(goto).not.toHaveBeenCalled();
    }
  );
  it('never for a shallow navigation, a cold open or the same address', () => {
    recordArrival(nav('link', { shallow: true }));
    recordArrival({ type: 'link', from: null, to: { url: new URL('http://x/a') } });
    recordArrival(nav('link', { from: 'http://x/a', to: 'http://x/a' }));
    expect(goto).not.toHaveBeenCalled();
  });
});

describe('a Back arrow is answered where every in-app link click is decided', () => {
  function arrow(href = '/associations'): HTMLAnchorElement {
    document.body.innerHTML = `<a href="${href}" ${BACK_LINK_ATTRIBUTE}><span>x</span></a>`;
    return document.querySelector('a')!;
  }
  function click(el: Element, over: MouseEventInit = {}) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...over });
    el.querySelector('span')!.dispatchEvent(e);
    handleAppLinkClick(e);
    return e;
  }

  it('walks history when the entry came from another section, and cancels the link', () => {
    state.page.url = new URL('http://x/associations/bde');
    state.page.state = { from: '/posts' };
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    const e = click(arrow());
    expect(back).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves the structural link alone with no origin', () => {
    state.page.url = new URL('http://x/associations/bde');
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    expect(backLinkTaken(arrow())).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('never for a link that is not an arrow, or a modified click', () => {
    state.page.url = new URL('http://x/associations/bde');
    state.page.state = { from: '/posts' };
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    document.body.innerHTML = '<a href="/associations"><span>x</span></a>';
    click(document.body);
    click(arrow(), { ctrlKey: true });
    expect(back).not.toHaveBeenCalled();
  });
});

describe('the markup carries the attribute the handler reads', () => {
  it.each(['Breadcrumb.svelte', 'PageHeader.svelte'])('%s', (name) => {
    const dir = name === 'Breadcrumb.svelte' ? 'navigation' : 'layout';
    const src = readFileSync(resolve(__dirname, `../components/${dir}/${name}`), 'utf8');
    expect(src).toContain(BACK_LINK_ATTRIBUTE);
  });
});
