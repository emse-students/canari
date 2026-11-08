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
  callScreenAwake,
  releaseIosIdleTimerOfPreviousPage,
  resetIosIdleTimerForTest,
  setIosIdleTimerDisabled,
} from './iosCallIdleTimer';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), 'utf8');

beforeEach(() => {
  logs.length = 0;
  resetIosIdleTimerForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('callScreenAwake', () => {
  it('on iOS, holds through the idle timer and never asks the engine for a wake lock', () => {
    const postMessage = vi.fn();
    const request = vi.fn();
    vi.stubGlobal('webkit', { messageHandlers: { canariIdleTimer: { postMessage } } });
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const awake = callScreenAwake(true);
    expect(awake).not.toBeInstanceOf(ScreenWakeLock);
    void awake.hold();
    void awake.hold(); // the return to the foreground: no second message
    awake.release();
    awake.release();
    expect(postMessage.mock.calls).toEqual([[true], [false]]);
    expect(request).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('refused'))).toBe(false);
  });

  it('elsewhere, holds through the Screen Wake Lock tagged CALL-WAKE', () => {
    expect(callScreenAwake(false)).toBeInstanceOf(ScreenWakeLock);
  });
});

describe('setIosIdleTimerDisabled', () => {
  it('an ask with no handler is an ERROR; a release with none is not', () => {
    setIosIdleTimerDisabled(false, 'idle');
    expect(logs.some((l) => l.includes('ERROR'))).toBe(false);
    setIosIdleTimerDisabled(true, 'video');
    expect(logs.some((l) => l.includes('ERROR no canariIdleTimer handler'))).toBe(true);
  });

  it('the handler name is the one canari_ios.mm registers, and it sets idleTimerDisabled', () => {
    const mm = read('../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm');
    expect(mm).toContain('addScriptMessageHandler:handler name:@"canariIdleTimer"');
    expect(mm).toContain('CanariObserveCallIdleTimer();');
    expect(mm).toContain('app.idleTimerDisabled = disabled;');
  });
});

describe('releaseIosIdleTimerOfPreviousPage', () => {
  it('posts false at every page load, even when this module believes it already did', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('webkit', { messageHandlers: { canariIdleTimer: { postMessage } } });
    setIosIdleTimerDisabled(false, 'the call ended');
    releaseIosIdleTimerOfPreviousPage();
    expect(postMessage.mock.calls).toEqual([[false], [false]]);
  });

  it('runs once per page load from the root layout, on iOS', () => {
    const layout = read('../../routes/+layout.svelte');
    expect(layout).toMatch(/if \(isIosTauriRuntime\(\)\) releaseIosIdleTimerOfPreviousPage\(\);/);
  });

  it('the call screen takes its holder from the platform, not from a refusal', () => {
    const overlay = read('../components/chat/CallOverlay.svelte');
    expect(overlay).toContain('const wakeLock = callScreenAwake();');
    expect(overlay).not.toContain('new ScreenWakeLock(');
  });
});
