/**
 * WHICH DEVICES DRAW THE VIDEO CONTROLS AS BLURRED GLASS (owner, 2026-11-09): Android stays flat
 * until its Mi 9T measurement, a low-end device is flat, everything else is glass - decided from
 * facts the device states, never from a frame time.
 */
import { describe, expect, it } from 'vitest';
import {
  ANDROID_VIDEO_GLASS,
  LOW_END_CORES,
  LOW_END_MEMORY_GB,
  decideVideoGlass,
} from './videoGlass';

describe('decideVideoGlass', () => {
  it('keeps Android flat until its measurement flips the switch', () => {
    expect(ANDROID_VIDEO_GLASS, 'flipped only with the Mi 9T reading (video-player.md)').toBe(
      false
    );
    expect(decideVideoGlass({ android: true, deviceMemoryGb: 8, cores: 8 })).toBe('flat');
  });

  it('reads the low-end numbers on Android only: WebKit rounds its core count for privacy', () => {
    // With Android still flat, the low-end rule is not reachable there yet; off Android it never applies.
    expect(decideVideoGlass({ android: false, deviceMemoryGb: LOW_END_MEMORY_GB })).toBe('glass');
    expect(decideVideoGlass({ android: false, cores: LOW_END_CORES })).toBe('glass');
  });

  it('draws glass on iOS and a desktop, including where the engine states nothing', () => {
    expect(decideVideoGlass({ android: false })).toBe('glass');
    expect(decideVideoGlass({ android: false, deviceMemoryGb: 8, cores: 6 })).toBe('glass');
  });
});
