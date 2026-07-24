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
    expect(inAppPathFromHref('/dashboard')).toBe('/dashboard');
    expect(inAppPathFromHref('/admin/platform')).toBe('/admin/platform');
    expect(inAppPathFromHref('/c/join/abc-token')).toBe('/c/join/abc-token');
    expect(inAppPathFromHref('/g/join/xyz-token')).toBe('/g/join/xyz-token');
  });

  it('keeps every non-backend Canari path in-app (no duplicate tab)', () => {
    expect(inAppPathFromHref('/settings')).toBe('/settings');
    expect(inAppPathFromHref('/lists/abc')).toBe('/lists/abc');
    expect(inAppPathFromHref('/legal/cgu')).toBe('/legal/cgu');
    // Formerly returned null (allowlist miss); the denylist now keeps it in-app.
    expect(inAppPathFromHref('/unknown')).toBe('/unknown');
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/settings')).toBe('/settings');
  });

  it('never swallows backend endpoints into in-app navigation', () => {
    expect(inAppPathFromHref('/api/version')).toBeNull();
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/api/version')).toBeNull();
    expect(inAppPathFromHref('/.well-known/assetlinks.json')).toBeNull();
  });

  it('maps public dashboard URLs without swallowing navigation', () => {
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/dashboard')).toBe('/dashboard');
    expect(inAppPathFromPublicUrl('https://canari-emse.fr/admin/moderation')).toBe(
      '/admin/moderation'
    );
  });

  it('labels in-app links for the chat UI', () => {
    expect(publicAppLinkLabel('https://canari-emse.fr/posts/abc')).toBe('Publication');
    expect(publicAppLinkLabel('https://canari-emse.fr/c/join/tok123')).toBe(
      'Invitation communauté'
    );
    expect(publicAppLinkLabel('https://canari-emse.fr/g/join/tok456')).toBe(
      'Invitation discussion'
    );
    expect(publicAppLinkLabel('https://example.com/x')).toBeNull();
  });
});
