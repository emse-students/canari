// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ android: true, ios: false }));
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => runtime.android,
  isIosTauriRuntime: () => runtime.ios,
}));

import {
  initScreenOrientation,
  orientationCanBeForced,
  requestOrientation,
  resetScreenOrientationForTest,
  rotateTarget,
  useScreenOrientation,
  viewportOrientation,
} from './screenOrientation.svelte';

type Win = Window & {
  canariOrientation?: { set: (m: string) => void };
  webkit?: { messageHandlers?: { canariOrientation?: { postMessage: (m: string) => void } } };
};

describe('screen orientation (one stack of requests, released on unmount)', () => {
  let sent: string[];

  beforeEach(() => {
    resetScreenOrientationForTest();
    runtime.android = true;
    runtime.ios = false;
    sent = [];
    (window as Win).canariOrientation = { set: (m) => sent.push(m) };
    delete (window as Win).webkit;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as Win).canariOrientation;
    vi.restoreAllMocks();
  });

  it('posts portrait at every page load, whatever the previous page left', () => {
    initScreenOrientation();
    expect(sent).toEqual(['portrait']);
    // A second load (a reload) posts again: the memory of what was sent was the previous page's.
    initScreenOrientation();
    expect(sent).toEqual(['portrait', 'portrait']);
  });

  it('turns while a screen holds a request, and only its release returns to portrait', () => {
    initScreenOrientation();
    const viewer = requestOrientation('auto', 'viewer');
    expect(sent.at(-1)).toBe('auto');
    viewer.set('landscape');
    expect(sent.at(-1)).toBe('landscape');
    viewer.release();
    expect(sent).toEqual(['portrait', 'auto', 'landscape', 'portrait']);
  });

  it('lets the newest request decide and hands the turn back when it is released', () => {
    initScreenOrientation();
    const camera = requestOrientation('auto', 'camera');
    const viewer = requestOrientation('landscape', 'viewer');
    expect(sent.at(-1)).toBe('landscape');
    // The camera changing its mode under the open viewer changes nothing on screen.
    camera.set('portrait');
    expect(sent.at(-1)).toBe('landscape');
    viewer.release();
    expect(sent.at(-1)).toBe('portrait');
    camera.set('auto');
    expect(sent.at(-1)).toBe('auto');
    camera.release();
    expect(sent.at(-1)).toBe('portrait');
  });

  it('posts nothing for a request that changes nothing, and a double release is harmless', () => {
    initScreenOrientation();
    const a = requestOrientation('auto', 'a');
    const b = requestOrientation('auto', 'b');
    b.release();
    b.release();
    a.set('auto');
    expect(sent).toEqual(['portrait', 'auto']);
    a.release();
    expect(sent).toEqual(['portrait', 'auto', 'portrait']);
  });

  it('a released request ignores a late set', () => {
    initScreenOrientation();
    const a = requestOrientation('auto', 'a');
    a.release();
    a.set('landscape');
    expect(sent).toEqual(['portrait', 'auto', 'portrait']);
  });

  it('reaches the iOS message handler on the iPhone', () => {
    runtime.android = false;
    runtime.ios = true;
    const posted: string[] = [];
    (window as Win).webkit = {
      messageHandlers: { canariOrientation: { postMessage: (m) => posted.push(m) } },
    };
    initScreenOrientation();
    requestOrientation('landscape', 'live').release();
    expect(posted).toEqual(['portrait', 'landscape', 'portrait']);
    expect(sent).toEqual([]);
  });

  it('says once, loudly, that a native build lost its bridge - and never for portrait', () => {
    delete (window as Win).canariOrientation;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    initScreenOrientation();
    expect(error).not.toHaveBeenCalled();
    requestOrientation('auto', 'a');
    requestOrientation('landscape', 'b');
    expect(error).toHaveBeenCalledTimes(1);
    expect(orientationCanBeForced()).toBe(false);
  });

  it('asks nothing of the web build, where the rotate button is not drawn', () => {
    runtime.android = false;
    const info = vi.spyOn(console, 'info');
    initScreenOrientation();
    requestOrientation('landscape', 'viewer').release();
    expect(sent).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(orientationCanBeForced()).toBe(false);
  });

  it("a component's hold: auto while mounted, the button, a frozen take, portrait at unmount", () => {
    initScreenOrientation();
    // happy-dom's window is 1024x768, a landscape viewport: start upright, as a phone does.
    viewportOrientation.landscape = false;
    let hook!: ReturnType<typeof useScreenOrientation>;
    const unmount = $effect.root(() => {
      hook = useScreenOrientation('camera');
    });
    flushSync();
    expect(sent.at(-1)).toBe('auto');
    // The button from portrait: landscape, with the lock on too.
    hook.rotate();
    expect(sent.at(-1)).toBe('landscape');
    viewportOrientation.landscape = true;
    // A take freezes what is on screen, and the button stands down under it.
    hook.hold(true);
    hook.rotate();
    expect(sent.at(-1)).toBe('landscape');
    hook.hold(false);
    // The second press: portrait, forced.
    hook.rotate();
    expect(sent.at(-1)).toBe('portrait');
    unmount();
    expect(sent).toEqual(['portrait', 'auto', 'landscape', 'portrait']);
  });

  it('a hold under auto freezes the orientation the phone was turned to, and gives it back', () => {
    initScreenOrientation();
    // happy-dom's window is 1024x768, a landscape viewport: start upright, as a phone does.
    viewportOrientation.landscape = false;
    let hook!: ReturnType<typeof useScreenOrientation>;
    const unmount = $effect.root(() => {
      hook = useScreenOrientation('live-broadcaster');
    });
    flushSync();
    viewportOrientation.landscape = true;
    hook.hold(true);
    hook.hold(true);
    expect(sent).toEqual(['portrait', 'auto', 'landscape']);
    hook.hold(false);
    expect(sent.at(-1)).toBe('auto');
    unmount();
    expect(sent.at(-1)).toBe('portrait');
  });

  it('the rotate button asks for the other orientation from the one on screen', () => {
    expect(rotateTarget(false)).toBe('landscape');
    expect(rotateTarget(true)).toBe('portrait');
  });
});
