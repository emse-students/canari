/**
 * The save button: a save says so, a refused gallery turns the button into the way to the settings,
 * and a failure says it failed. `saveReel` and the settings call are stand-ins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelSaveButton from './ReelSaveButton.svelte';
import type { MyReel } from '$lib/posts/api';

const saveReel = vi.fn();
const openAppSettings = vi.fn(async () => {});
const showToast = vi.fn();
vi.mock('$lib/reels/saveReel', () => ({ saveReel: (r: MyReel) => saveReel(r) }));
vi.mock('$lib/reels/gallery', () => ({ openAppSettings: () => openAppSettings() }));
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (...a: unknown[]) => showToast(...a),
}));

const reel = { id: 'r1' } as MyReel;
const mounted: Record<string, unknown>[] = [];

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ReelSaveButton, { target, props: { reel } }));
  flushSync();
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await tick();
    }
    flushSync();
  };
  return { target, settle };
}

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ReelSaveButton', () => {
  it('saves and says so', async () => {
    saveReel.mockResolvedValueOnce('saved');
    const { target, settle } = await render();
    target.querySelector<HTMLButtonElement>('[data-reel-save]')!.click();
    await settle();
    expect(saveReel).toHaveBeenCalledWith(reel);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('a refused gallery offers the settings, and they open', async () => {
    saveReel.mockResolvedValueOnce('denied');
    const { target, settle } = await render();
    target.querySelector<HTMLButtonElement>('[data-reel-save]')!.click();
    await settle();
    const settings = target.querySelector<HTMLButtonElement>('[data-reel-open-settings]')!;
    expect(settings).not.toBeNull();
    settings.click();
    await settle();
    expect(openAppSettings).toHaveBeenCalled();
    expect(target.querySelector('[data-reel-save]')).not.toBeNull();
  });

  it('a failure says it failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    saveReel.mockRejectedValueOnce(new Error('disk'));
    const { target, settle } = await render();
    target.querySelector<HTMLButtonElement>('[data-reel-save]')!.click();
    await settle();
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
