// @vitest-environment happy-dom
import {
  REFUSED_ROTATION_RELOADS_KEY,
  forgetRefusedRotationReloads,
} from './refusedRotationReloads';

/**
 * What the session's end calls (`tearDownLiveSession`, pinned in `signOutEndsLiveSession.test.ts`):
 * a sign-in after a sign-out in the same tab must not inherit a run of refused-rotation reloads.
 */
describe('forgetRefusedRotationReloads', () => {
  it("removes the tab's count and nothing else", () => {
    sessionStorage.clear();
    sessionStorage.setItem(REFUSED_ROTATION_RELOADS_KEY, '2');
    sessionStorage.setItem('unrelated', 'kept');
    forgetRefusedRotationReloads();
    expect(sessionStorage.getItem(REFUSED_ROTATION_RELOADS_KEY)).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
  });
});
