// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import GifTileImage from './GifTileImage.svelte';

const gate = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('$lib/utils/chat/gifImageGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/gifImageGate')>();
  gate.current = actual.createImageGate(1);
  return { ...actual, gifImageGate: gate.current };
});

let target: HTMLElement;
const apps: Record<string, unknown>[] = [];

function tile(src: string) {
  const onLoad = vi.fn();
  apps.push(
    mount(GifTileImage, { target, props: { src, width: 100, height: 100, onLoad } }) as Record<
      string,
      unknown
    >
  );
  return onLoad;
}

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  for (const app of apps.splice(0)) void unmount(app);
  target.remove();
  vi.useRealTimers();
});

const imgs = () => target.querySelectorAll('img');

describe('GifTileImage', () => {
  it('waits for a slot, and hands it on when its picture loaded', async () => {
    tile('https://x/a.gif');
    tile('https://x/b.gif');
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(imgs()).toHaveLength(1);
    expect(imgs()[0].getAttribute('src')).toBe('https://x/a.gif');

    imgs()[0].dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(Array.from(imgs()).map((i) => i.getAttribute('src'))).toContain('https://x/b.gif');
  });

  it('retries once after an error, then shows it failed instead of staying blank', async () => {
    tile('https://x/c.gif');
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    imgs()[0].dispatchEvent(new Event('error'));
    flushSync();
    expect(imgs()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(900);
    flushSync();
    expect(imgs()).toHaveLength(1);
    imgs()[0].dispatchEvent(new Event('error'));
    flushSync();
    expect(imgs()).toHaveLength(0);
    expect(target.querySelector('svg')).not.toBeNull();
  });
});
