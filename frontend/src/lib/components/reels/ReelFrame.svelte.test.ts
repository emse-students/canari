// @vitest-environment happy-dom
/**
 * The ONE reel frame, through the real component: edge to edge with square corners when the screen has
 * its shape, rounded over a backdrop when it does not, and a stage that holds its height only while
 * the latch (the editor's keyboard) is set.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import ReelFrame from './ReelFrame.svelte';

let box = { width: 360, height: 640 };
const observers: (() => void)[] = [];
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => box.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => box.height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        const fire = () =>
          this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
        observers.push(fire);
        fire();
      }
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  observers.length = 0;
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const children = createRawSnippet(() => ({ render: () => '<span data-child></span>' }));

function mountFrame(props: { ratio?: number; latch?: boolean } = {}) {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(ReelFrame, { target, props: { ...props, children } }));
  flushSync();
  return target;
}

const frameOf = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-reel-frame]')!;

it('is the whole stage with square corners and no backdrop on a screen of its shape', () => {
  box = { width: 360, height: 640 };
  const frame = frameOf(mountFrame());
  expect(frame.dataset.reelFrameFills).toBe('true');
  expect(frame.className).not.toContain('rounded');
  expect(frame.style.width).toBe('360px');
  expect(frame.style.height).toBe('640px');
  expect(document.querySelector('[data-reel-backdrop]')).toBeNull();
});

it('is centred and rounded over a backdrop on a taller screen', () => {
  box = { width: 360, height: 800 };
  const frame = frameOf(mountFrame());
  expect(frame.dataset.reelFrameFills).toBe('false');
  expect(frame.className).toContain('rounded-2xl');
  expect(frame.style.width).toBe('360px');
  expect(frame.style.height).toBe('640px');
  expect(frame.style.top).toBe('80px');
  expect(document.querySelector('[data-reel-backdrop]')).not.toBeNull();
  expect(frame.querySelector('[data-child]')).not.toBeNull();
});

it('wears the media ratio it is given', () => {
  box = { width: 360, height: 800 };
  const frame = frameOf(mountFrame({ ratio: 1 }));
  expect(frame.style.width).toBe('360px');
  expect(frame.style.height).toBe('360px');
});

function resizeTo(next: { width: number; height: number }) {
  box = next;
  for (const fire of observers) fire();
  flushSync();
}

it('follows a shrinking box when nothing latches (the camera records what is visible)', () => {
  box = { width: 360, height: 800 };
  const frame = frameOf(mountFrame());
  expect(frame.style.top).toBe('80px');
  resizeTo({ width: 360, height: 640 });
  expect(frame.style.top).toBe('0px');
});

it('holds the stage height while latched, and releases once the box grows back', () => {
  box = { width: 360, height: 800 };
  const props = $state({ latch: false });
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(ReelFrame, {
      target,
      props: {
        get latch() {
          return props.latch;
        },
        children,
      },
    })
  );
  flushSync();
  const frame = frameOf(target);
  props.latch = true;
  flushSync();
  resizeTo({ width: 360, height: 480 });
  expect(frame.style.top).toBe('80px');
  props.latch = false;
  flushSync();
  expect(frame.style.top).toBe('80px');
  resizeTo({ width: 360, height: 800 });
  expect(frame.style.top).toBe('80px');
  resizeTo({ width: 360, height: 640 });
  expect(frame.style.top).toBe('0px');
});
