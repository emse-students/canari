import { cameraOriginFrom, CAMERA_DEFAULT_ORIGIN } from './cameraOrigin';

describe('cameraOriginFrom', () => {
  it('returns the tab the camera was opened from', () => {
    expect(cameraOriginFrom(new URL('https://x.test/dashboard'))).toBe('/dashboard');
    expect(cameraOriginFrom(new URL('https://x.test/posts?tab=all'))).toBe('/posts?tab=all');
  });

  it('answers the feed for a cold link', () => {
    expect(cameraOriginFrom(null)).toBe(CAMERA_DEFAULT_ORIGIN);
    expect(cameraOriginFrom(undefined)).toBe(CAMERA_DEFAULT_ORIGIN);
  });

  it('never answers the camera itself', () => {
    expect(cameraOriginFrom(new URL('https://x.test/camera'))).toBe(CAMERA_DEFAULT_ORIGIN);
  });
});
