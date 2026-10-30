import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({
  appendLog: (msg: string) => logs.push(msg),
}));

import {
  callHoldsProximity,
  releaseIosProximityOfPreviousPage,
  resetIosProximityForTest,
  setIosProximityMonitoring,
} from './iosCallProximity';

beforeEach(() => {
  logs.length = 0;
  resetIosProximityForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('callHoldsProximity', () => {
  it('holds while the call has the microphone and the voice is on the receiver', () => {
    for (const kind of ['ringing', 'connecting', 'live', 'reconnecting'] as const) {
      expect(callHoldsProximity(kind, true, false)).toBe(true);
    }
  });

  it('never on the loudspeaker, before the microphone, or outside a call', () => {
    expect(callHoldsProximity('live', true, true)).toBe(false);
    expect(callHoldsProximity('live', false, false)).toBe(false);
    for (const kind of ['idle', 'incoming', 'ended'] as const) {
      expect(callHoldsProximity(kind, true, false)).toBe(false);
    }
  });
});

describe('setIosProximityMonitoring', () => {
  it('posts each change once to the canariProximity handler', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('webkit', { messageHandlers: { canariProximity: { postMessage } } });
    setIosProximityMonitoring(true, 'a');
    setIosProximityMonitoring(true, 'b');
    setIosProximityMonitoring(false, 'c');
    expect(postMessage.mock.calls).toEqual([[true], [false]]);
  });

  it('an ask with no handler is an ERROR; a release with none is not', () => {
    setIosProximityMonitoring(false, 'idle');
    expect(logs.some((l) => l.includes('ERROR'))).toBe(false);
    setIosProximityMonitoring(true, 'earpiece');
    expect(logs.some((l) => l.includes('ERROR no canariProximity handler'))).toBe(true);
  });

  it('the handler name is the one canari_ios.mm registers', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const mm = readFileSync(
      resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm'),
      'utf8'
    );
    expect(mm).toContain('addScriptMessageHandler:handler name:@"canariProximity"');
    expect(mm).toContain('CanariObserveCallProximity();');
  });

  it('native arms the sensor only on the receiver route, and re-decides on every route change', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const mm = readFileSync(
      resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm'),
      'utf8'
    );
    expect(mm).toContain('AVAudioSessionPortBuiltInReceiver');
    expect(mm).toContain('BOOL enabled = self.pageWants && onReceiver;');
    expect(mm).toContain('addObserverForName:AVAudioSessionRouteChangeNotification');
  });
});

describe('releaseIosProximityOfPreviousPage', () => {
  it('posts false at every page load, even when this module believes it already did', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('webkit', { messageHandlers: { canariProximity: { postMessage } } });
    setIosProximityMonitoring(false, 'the call ended');
    releaseIosProximityOfPreviousPage();
    expect(postMessage.mock.calls).toEqual([[false], [false]]);
  });

  it('runs once per page load from the root layout, on iOS', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const layout = readFileSync(resolve(here, '../../routes/+layout.svelte'), 'utf8');
    expect(layout).toMatch(/if \(isIosTauriRuntime\(\)\) releaseIosProximityOfPreviousPage\(\);/);
  });
});
