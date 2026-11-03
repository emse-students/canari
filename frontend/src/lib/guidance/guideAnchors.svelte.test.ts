// @vitest-environment happy-dom
/**
 * THE ANCHOR REGISTRY: an id resolves to its RENDERED source, a region stands in for a native control,
 * and registering from inside an effect - where actions and the native tab bar register - never makes
 * that effect re-run on its own write.
 */
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  guideAnchorsVersion,
  registerGuideRegion,
  resolveGuideAnchor,
} from './guideAnchors.svelte';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {} } }));

describe('guide anchor registry', () => {
  it('resolves a region with area, and forgets it once released', () => {
    const release = registerGuideRegion('test.region', () => ({
      left: 0,
      top: 10,
      width: 100,
      height: 40,
    }));
    expect(resolveGuideAnchor('test.region')?.element).toBeNull();
    expect(resolveGuideAnchor('test.region')?.rect()).toEqual({
      left: 0,
      top: 10,
      width: 100,
      height: 40,
    });
    release();
    expect(resolveGuideAnchor('test.region')).toBeNull();
  });

  it('does not resolve a region with no area (the bar is not on screen)', () => {
    const release = registerGuideRegion('test.empty', () => null);
    expect(resolveGuideAnchor('test.empty')).toBeNull();
    release();
  });

  it('registers from inside an effect without re-running it', () => {
    let runs = 0;
    const before = guideAnchorsVersion();
    const stop = $effect.root(() => {
      $effect(() => {
        runs++;
        const release = registerGuideRegion('test.effect', () => null);
        return release;
      });
    });
    flushSync();
    expect(runs).toBe(1);
    expect(guideAnchorsVersion()).toBe(before + 1);
    stop();
    expect(guideAnchorsVersion()).toBe(before + 2);
  });
});
