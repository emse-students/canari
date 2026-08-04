import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './authSessions';

const UNKNOWN = 'Appareil inconnu';

describe('describeUserAgent', () => {
  it('falls back when nothing was recorded', () => {
    expect(describeUserAgent(null, UNKNOWN)).toEqual({ label: UNKNOWN, kind: 'desktop' });
    expect(describeUserAgent('   ', UNKNOWN).label).toBe(UNKNOWN);
  });

  it('names a desktop browser and its platform', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua, UNKNOWN)).toEqual({ label: 'Chrome - Windows', kind: 'desktop' });
  });

  it('prefers the specific Chromium fork over the Chrome token they all carry', () => {
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
    expect(describeUserAgent(edge, UNKNOWN).label).toBe('Edge - Windows');

    const opera =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0';
    expect(describeUserAgent(opera, UNKNOWN).label).toBe('Opera - Windows');
  });

  it('marks phones and tablets as mobile', () => {
    const android =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
    expect(describeUserAgent(android, UNKNOWN)).toEqual({
      label: 'Chrome - Android',
      kind: 'mobile',
    });

    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(iphone, UNKNOWN)).toEqual({
      label: 'Safari - iPhone',
      kind: 'mobile',
    });
  });

  it('reads an Android phone as Android, not as the Linux it also claims to be', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua, UNKNOWN).kind).toBe('mobile');
  });

  it('reads an iPhone as iPhone, not as the Mac OS X it mentions', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    expect(describeUserAgent(ua, UNKNOWN).label).toBe('Safari - iPhone');
  });

  it('still names the platform when the browser is unrecognised', () => {
    expect(describeUserAgent('curl/8.5.0 (Linux)', UNKNOWN)).toEqual({
      label: 'Linux',
      kind: 'desktop',
    });
  });

  it('falls back when neither half is recognised', () => {
    expect(describeUserAgent('something-opaque/1.0', UNKNOWN).label).toBe(UNKNOWN);
  });
});
