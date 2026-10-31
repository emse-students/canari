import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_CHROMIUM_MP4_FROM,
  classifyRecordingGap,
  liveRecordingGap,
  liveRecordingSupported,
} from './liveRecorder';
import { LIVE_RECORDER_MIME } from './constants';

const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const chrome = (v: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const EDGE_OLD = `${chrome(120)} Edg/120.0.0.0`;
const SAFARI_OLD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1 Safari/605.1.15';

describe('classifyRecordingGap', () => {
  it('names Firefox, whatever its version', () => {
    expect(classifyRecordingGap(FIREFOX)).toBe('firefox');
  });
  it('calls a Chromium before the MP4 recorder outdated, Edge included', () => {
    expect(classifyRecordingGap(chrome(LIVE_CHROMIUM_MP4_FROM - 1))).toBe('outdated');
    expect(classifyRecordingGap(EDGE_OLD)).toBe('outdated');
  });
  it('leaves a recent Chromium and any other engine as other', () => {
    expect(classifyRecordingGap(chrome(LIVE_CHROMIUM_MP4_FROM))).toBe('other');
    expect(classifyRecordingGap(SAFARI_OLD)).toBe('other');
    expect(classifyRecordingGap('')).toBe('other');
  });
});

describe('liveRecordingGap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is null when the engine records exactly the live container', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (t: string) => t === LIVE_RECORDER_MIME });
    expect(liveRecordingSupported()).toBe(true);
    expect(liveRecordingGap()).toBeNull();
  });

  it('says why when the container is refused (Firefox records WebM only)', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (t: string) => t.startsWith('video/webm') });
    vi.stubGlobal('navigator', { userAgent: FIREFOX });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(liveRecordingGap()).toBe('firefox');
  });

  it('says why when there is no MediaRecorder at all', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.stubGlobal('navigator', { userAgent: chrome(100) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(liveRecordingGap()).toBe('outdated');
  });
});
