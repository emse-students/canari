import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({
  appendLog: (msg: string) => logs.push(msg),
}));

import { ScreenWakeLock } from '$lib/live/liveDevice';
import {
  releaseIosIdleTimerOfPreviousPage,
  resetIosIdleTimerForTest,
  screenAwakeHolder,
  setIosIdleTimerHeld,
} from './screenAwake';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), 'utf8');
const mm = () => read('../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm');

type Message = { owner: string; hold: boolean } | { reset: true };

/**
 * The native handler's rule, as `CanariIdleTimerHandler` applies it: a set of owners, the screen
 * held while it is not empty, `{reset}` empties it. The `.mm` is pinned to that rule below.
 */
function stubNativeSet() {
  const owners = new Set<string>();
  const postMessage = vi.fn((m: Message) => {
    if ('reset' in m) owners.clear();
    else if (m.hold) owners.add(m.owner);
    else owners.delete(m.owner);
  });
  vi.stubGlobal('webkit', { messageHandlers: { canariIdleTimer: { postMessage } } });
  return { postMessage, disabled: () => owners.size > 0 };
}

beforeEach(() => {
  logs.length = 0;
  resetIosIdleTimerForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('screenAwakeHolder', () => {
  it('on iOS, holds through the idle timer and never asks the engine for a wake lock', async () => {
    const native = stubNativeSet();
    const request = vi.fn();
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const call = screenAwakeHolder('call', true);
    expect(call).not.toBeInstanceOf(ScreenWakeLock);
    await call.hold();
    await call.hold(); // the return to the foreground: no second message
    call.release();
    call.release();
    expect(native.postMessage.mock.calls).toEqual([
      [{ owner: 'call', hold: true }],
      [{ owner: 'call', hold: false }],
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('refused'))).toBe(false);
    expect(logs.every((l) => l.startsWith('[CALL-WAKE]'))).toBe(true);
  });

  it('elsewhere, holds through the Screen Wake Lock', () => {
    expect(screenAwakeHolder('call', false)).toBeInstanceOf(ScreenWakeLock);
    expect(screenAwakeHolder('live', false)).toBeInstanceOf(ScreenWakeLock);
  });

  it('a live logs under its own tag', async () => {
    stubNativeSet();
    await screenAwakeHolder('live', true).hold();
    expect(logs).toEqual(['[LIVE-WAKE] iOS idle timer held (the live holds the screen)']);
  });
});

describe('a call and a live overlapping on iOS', () => {
  it('the call released first leaves the live holding the screen', async () => {
    const native = stubNativeSet();
    const call = screenAwakeHolder('call', true);
    const live = screenAwakeHolder('live', true);
    await call.hold();
    await live.hold();
    call.release();
    expect(native.disabled()).toBe(true);
    live.release();
    expect(native.disabled()).toBe(false);
  });

  it('the live released first leaves the call holding the screen', async () => {
    const native = stubNativeSet();
    const call = screenAwakeHolder('call', true);
    const live = screenAwakeHolder('live', true);
    await live.hold();
    await call.hold();
    live.release();
    expect(native.disabled()).toBe(true);
    call.release();
    expect(native.disabled()).toBe(false);
  });

  it('one owner released twice never drops the other', async () => {
    const native = stubNativeSet();
    const call = screenAwakeHolder('call', true);
    await call.hold();
    await screenAwakeHolder('live', true).hold();
    call.release();
    call.release();
    expect(native.disabled()).toBe(true);
  });

  it('the native handler applies that same rule: a set of owners, held while not empty', () => {
    const source = mm();
    expect(source).toContain('NSMutableSet<NSString *> *owners');
    expect(source).toContain('[self.owners addObject:owner];');
    expect(source).toContain('[self.owners removeObject:owner];');
    expect(source).toContain('[self.owners removeAllObjects];');
    expect(source).toContain('app.idleTimerDisabled = self.owners.count > 0;');
  });
});

describe('setIosIdleTimerHeld', () => {
  it('an ask with no handler is an ERROR; a release with none is not', () => {
    setIosIdleTimerHeld('call', false, 'idle');
    expect(logs.some((l) => l.includes('ERROR'))).toBe(false);
    setIosIdleTimerHeld('call', true, 'video');
    expect(logs.some((l) => l.includes('[CALL-WAKE] ERROR no canariIdleTimer handler'))).toBe(true);
  });

  it('the handler name is the one canari_ios.mm registers', () => {
    const source = mm();
    expect(source).toContain('addScriptMessageHandler:handler name:@"canariIdleTimer"');
    expect(source).toContain('CanariObserveCallIdleTimer();');
  });
});

describe('releaseIosIdleTimerOfPreviousPage', () => {
  it('empties the native set at every page load, whatever this module believes', async () => {
    const native = stubNativeSet();
    await screenAwakeHolder('call', true).hold();
    await screenAwakeHolder('live', true).hold();
    releaseIosIdleTimerOfPreviousPage();
    expect(native.disabled()).toBe(false);
    expect(native.postMessage).toHaveBeenLastCalledWith({ reset: true });
    // The memory went with the reset: the next hold is posted again.
    await screenAwakeHolder('call', true).hold();
    expect(native.disabled()).toBe(true);
  });

  it('runs once per page load from the root layout, on iOS', () => {
    const layout = read('../../routes/+layout.svelte');
    expect(layout).toMatch(/if \(isIosTauriRuntime\(\)\) releaseIosIdleTimerOfPreviousPage\(\);/);
  });

  it('the call screen and the live take their holder from the platform, not from a refusal', () => {
    const overlay = read('../components/chat/CallOverlay.svelte');
    expect(overlay).toContain("const wakeLock = screenAwakeHolder('call');");
    expect(overlay).not.toContain('new ScreenWakeLock(');
    const live = read('../live/liveBroadcast.svelte.ts');
    expect(live).toContain("wakeLock: screenAwakeHolder('live'),");
    expect(live).not.toContain('new ScreenWakeLock(');
  });
});
