// @vitest-environment happy-dom
/** `expandFrom`: reduced motion, the View Transitions path and the CSS fallback's origin. */
import { afterEach, expect, it, vi } from 'vitest';
import { expandFrom } from './expandFrom';

type Doc = { startViewTransition?: unknown };

function button() {
  const el = document.createElement('button');
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 20,
    width: 40,
    height: 40,
    right: 140,
    bottom: 60,
  } as DOMRect);
  return el;
}

afterEach(() => {
  delete (document as Doc).startViewTransition;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('opens at once, with no transition, under reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const start = vi.fn();
  (document as Doc).startViewTransition = start;
  const commit = vi.fn();
  expandFrom(button(), commit);
  expect(start).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledExactlyOnceWith(null);
});

it('names the button before the transition, then clears it as the viewer mounts', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const el = button();
  const commit = vi.fn();
  let nameAtCall = '';
  (document as Doc).startViewTransition = (update: () => Promise<void>) => {
    nameAtCall = el.style.viewTransitionName;
    return { finished: update().then(() => undefined) };
  };
  expandFrom(el, commit);
  await Promise.resolve();
  expect(nameAtCall).toBe('reel-open');
  expect(el.style.viewTransitionName).toBe('');
  expect(commit).toHaveBeenCalledExactlyOnceWith(null);
});

it('hands the button centre to commit when there is no View Transitions API', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const commit = vi.fn();
  expandFrom(button(), commit);
  expect(commit).toHaveBeenCalledExactlyOnceWith({ x: 120, y: 40 });
});
