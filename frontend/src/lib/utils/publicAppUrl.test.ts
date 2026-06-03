import { describe, expect, it } from 'vitest';
import {
  inAppPathFromHref,
  inAppPathFromPublicUrl,
  isPublicAppUrl,
  publicAppLinkLabel,
  publicAppUrl,
} from './publicAppUrl';

describe('publicAppUrl', () => {
  it('uses the production origin on the Tauri WebView', () => {
    const prior = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...prior, origin: 'https://tauri.localhost' },
    });
    expect(publicAppUrl('/posts/abc')).toBe('https://canari-emse.fr/posts/abc');
    Object.defineProperty(window, 'location', { configurable: true, value: prior });
  });

  it('detects canari-emse.fr links', () => {
    expect(isPublicAppUrl('https://canari-emse.fr/forms/x')).toBe(true);
    expect(isPublicAppUrl('https://example.com/posts/x')).toBe(false);
  });

  it('maps public URLs to in-app paths', () => {
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/posts/abc?q=1')).toBe('/posts/abc?q=1');
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/post/legacy')).toBe('/posts/legacy');
    expect(inAppPathFromPublicUrl('https://evil.com/posts/x')).toBeNull();
  });

  it('maps relative paths to in-app routes', () => {
    expect(inAppPathFromHref('/forms/xyz')).toBe('/forms/xyz');
    expect(inAppPathFromHref('/unknown')).toBeNull();
  });

  it('labels in-app links for the chat UI', () => {
    expect(publicAppLinkLabel('https://canari-emse.fr/posts/abc')).toBe('Publication');
    expect(publicAppLinkLabel('https://example.com/x')).toBeNull();
  });
});
