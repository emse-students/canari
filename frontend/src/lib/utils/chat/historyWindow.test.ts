import { describe, it, expect, afterEach } from 'vitest';
import {
  NATIVE_DEVICE_WINDOW_MS,
  WEB_DEVICE_WINDOW_MS,
  deviceWindowMs,
  deviceWindowStart,
  historyRangeStart,
  isWithinHistoryRange,
  mergeHistoryFloor,
  parseHistoryFloor,
  parseHistorySince,
} from './historyWindow';

/**
 * The two boundaries of history reconciliation. Every case here passes `now` explicitly: a test
 * that reads the wall clock measures the machine it runs on rather than the rule it describes.
 */

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

/**
 * Pretends this process is the Tauri shell, which is the only thing the window size depends on.
 *
 * The marker is SET ON the existing window and never replaces it. Assigning a fresh object to
 * `globalThis.window` swaps out the whole jsdom environment - `localStorage` and everything else go
 * with it - and vitest reuses that environment across files, so it takes down every test file that
 * runs after this one rather than this one.
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function asNative(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

function asWeb(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

afterEach(asWeb);

describe('the device window', () => {
  it('is 90 days in a browser and 5 years in the native shell', () => {
    expect(deviceWindowMs()).toBe(WEB_DEVICE_WINDOW_MS);
    asNative();
    expect(deviceWindowMs()).toBe(NATIVE_DEVICE_WINDOW_MS);
  });

  it('opens one window before the instant it is asked about', () => {
    expect(deviceWindowStart(NOW)).toBe(NOW - WEB_DEVICE_WINDOW_MS);
  });
});

describe('parseHistoryFloor', () => {
  it('keeps a usable instant and floors it', () => {
    expect(parseHistoryFloor(1_700_000_000_123.7, NOW)).toBe(1_700_000_000_123);
  });

  it('rejects everything that is not one', () => {
    for (const raw of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'later', {}]) {
      expect(parseHistoryFloor(raw, NOW)).toBeUndefined();
    }
  });

  it('clamps a floor claimed in the future down to now', () => {
    // The merge is `max` and has no way back: a floor after the messages it is meant to bound would
    // put the whole conversation below it, on every device that merged it, permanently.
    expect(parseHistoryFloor(NOW + 10 * 365 * 24 * 3600 * 1000, NOW)).toBe(NOW);
  });
});

describe('mergeHistoryFloor', () => {
  it('takes the larger of the two', () => {
    expect(mergeHistoryFloor(1000, 2000, NOW)).toBe(2000);
  });

  it('answers null when the incoming floor is not ahead, so the caller skips its write', () => {
    expect(mergeHistoryFloor(2000, 2000, NOW)).toBeNull();
    expect(mergeHistoryFloor(2000, 1000, NOW)).toBeNull();
    expect(mergeHistoryFloor(undefined, undefined, NOW)).toBeNull();
    expect(mergeHistoryFloor(undefined, 'nonsense', NOW)).toBeNull();
  });

  it('accepts the first floor a conversation is ever told about', () => {
    expect(mergeHistoryFloor(undefined, 1000, NOW)).toBe(1000);
  });

  it('is idempotent, commutative and associative - which is what makes it converge', () => {
    const values = [5000, 1000, 3000];
    const fold = (order: number[]): number | undefined => {
      let held: number | undefined;
      for (const v of order) {
        const merged = mergeHistoryFloor(held, v, NOW);
        if (merged !== null) held = merged;
      }
      return held;
    };
    expect(fold(values)).toBe(5000);
    expect(fold([...values].reverse())).toBe(5000);
    expect(fold([...values, ...values])).toBe(5000);
  });
});

describe('historyRangeStart', () => {
  it('is the window when no floor has been agreed', () => {
    expect(historyRangeStart(undefined, NOW)).toBe(NOW - WEB_DEVICE_WINDOW_MS);
  });

  it('is the floor when the floor is the later of the two', () => {
    const floor = NOW - 10 * 24 * 3600 * 1000;
    expect(historyRangeStart(floor, NOW)).toBe(floor);
  });

  it('is the window when the floor is older than it - the phone is not shrunk by the browser', () => {
    asNative();
    const floor = NOW - 100 * 24 * 3600 * 1000;
    expect(historyRangeStart(floor, NOW)).toBe(floor);
    asWeb();
    // The same floor, read on the browser, is below its 90-day window - so the browser claims less.
    expect(historyRangeStart(floor, NOW)).toBe(NOW - WEB_DEVICE_WINDOW_MS);
  });
});

describe('parseHistorySince', () => {
  it('reads a stated range start', () => {
    expect(parseHistorySince(1500.9)).toBe(1500);
  });

  it('reads anything else as zero, i.e. answer in full', () => {
    // A frame that states no range is a frame from a path that has no window to state. Over-
    // answering costs bandwidth; under-answering loses messages.
    for (const raw of [undefined, null, 0, -1, Number.NaN, 'soon']) {
      expect(parseHistorySince(raw)).toBe(0);
    }
  });
});

describe('isWithinHistoryRange', () => {
  it('includes the boundary', () => {
    expect(isWithinHistoryRange(1000, 1000)).toBe(true);
    expect(isWithinHistoryRange(999, 1000)).toBe(false);
  });

  it('keeps a message whose timestamp cannot be compared', () => {
    expect(isWithinHistoryRange(Number.NaN, 1000)).toBe(true);
  });
});
