import { iosAppOpenHref, loginOpenInAppOffer } from './openInApp';
import { isClaimedAppLinkPath } from './appSiteAssociation';

/** Real browsers' user agents (only the system matters to the login offer). */
const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

describe('iosAppOpenHref', () => {
  const open = (page: string) => `fr.emse.canari://open?url=${encodeURIComponent(page)}`;

  it("the app's own scheme carrying a claimed page", () => {
    expect(iosAppOpenHref(new URL('https://canari.emse.fr/c/join/tok'))).toBe(
      open('https://canari.emse.fr/c/join/tok')
    );
    // The legacy name IS claimed.
    expect(iosAppOpenHref(new URL('https://canari-emse.fr/posts/abc'))).toBe(
      open('https://canari-emse.fr/posts/abc')
    );
  });

  it('behind the login redirect, the page the visitor came for', () => {
    expect(
      iosAppOpenHref(
        new URL(`https://canari.emse.fr/login?returnTo=${encodeURIComponent('/posts/abc?x=1')}`)
      )
    ).toBe(open('https://canari.emse.fr/posts/abc?x=1'));
    // A returnTo naming another host is refused, not offered.
    expect(
      iosAppOpenHref(new URL('https://canari.emse.fr/login?returnTo=//example.com/posts/abc'))
    ).toBeNull();
    // A bare /login is not a page of the app.
    expect(iosAppOpenHref(new URL('https://canari.emse.fr/login'))).toBeNull();
  });

  it('nothing for a path the app does not claim, a foreign page, or a name no filter holds', () => {
    expect(iosAppOpenHref(new URL('https://canari.emse.fr/auth/callback?code=1'))).toBeNull();
    expect(iosAppOpenHref(new URL('https://example.com/posts/abc'))).toBeNull();
    expect(iosAppOpenHref(new URL('https://dev.canari-emse.fr/posts/abc'))).toBeNull();
  });
});

describe('isClaimedAppLinkPath', () => {
  it('reads the same claim as the association files', () => {
    expect(isClaimedAppLinkPath('/')).toBe(true);
    expect(isClaimedAppLinkPath('/posts/abc')).toBe(true);
    expect(isClaimedAppLinkPath('/chat')).toBe(true);
    expect(isClaimedAppLinkPath('/auth/callback')).toBe(false);
    expect(isClaimedAppLinkPath('/admin')).toBe(false);
    // `/posts` alone is not claimed: only `/posts/*` is.
    expect(isClaimedAppLinkPath('/posts')).toBe(false);
  });
});

describe('loginOpenInAppOffer', () => {
  it('offers the app home from a bare /login, in a real browser, per system', () => {
    const android = loginOpenInAppOffer('https://canari.emse.fr/login', UA.chromeAndroid);
    expect(android?.openHref).toContain('intent://canari.emse.fr/chat#Intent;scheme=https;');
    const ios = loginOpenInAppOffer('https://canari.emse.fr/login', UA.safariIos);
    expect(ios?.openHref).toBe(
      `fr.emse.canari://open?url=${encodeURIComponent('https://canari.emse.fr/chat')}`
    );
  });

  it('prefers the claimed page behind returnTo', () => {
    const offer = loginOpenInAppOffer(
      'https://canari.emse.fr/login?returnTo=%2Fposts%2F42',
      UA.safariIos
    );
    expect(offer?.openHref).toContain(encodeURIComponent('https://canari.emse.fr/posts/42'));
  });

  it('offers nothing on a desktop, or on a host no App Link filter names', () => {
    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36';
    expect(loginOpenInAppOffer('https://canari.emse.fr/login', desktop)).toBeNull();
    expect(loginOpenInAppOffer('https://dev.canari-emse.fr/login', UA.chromeAndroid)).toBeNull();
  });
});
