import { detectInAppBrowser, loginOpenInAppOffer, openInAppOffer } from './openInApp';
import { isClaimedAppLinkPath } from './appSiteAssociation';
import { APP_STORE_URL, PLAY_STORE_URL } from '$lib/utils/appVersion';

/** User agents as those apps send them (tokens only matter; the rest is realistic padding). */
const UA = {
  messengerAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/480.0.0.0;]',
  messengerIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/480.0;FBDV/iPhone15,2]',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

describe('detectInAppBrowser', () => {
  it('recognises the Meta in-app browsers, per system', () => {
    expect(detectInAppBrowser(UA.messengerAndroid)).toBe('android');
    expect(detectInAppBrowser(UA.messengerIos)).toBe('ios');
    expect(detectInAppBrowser(UA.instagramIos)).toBe('ios');
  });

  it('leaves real browsers alone - they follow App Links by themselves', () => {
    expect(detectInAppBrowser(UA.chromeAndroid)).toBeNull();
    expect(detectInAppBrowser(UA.safariIos)).toBeNull();
  });
});

describe('openInAppOffer', () => {
  it('Android: an intent on the https App Link, the Play listing as fallback, no fragment', () => {
    const offer = openInAppOffer(
      'https://canari.emse.fr/posts/abc?x=1#comment',
      UA.messengerAndroid
    );

    expect(offer?.openHref).toBe(
      'intent://canari.emse.fr/posts/abc?x=1#Intent;scheme=https;package=fr.emse.canari;' +
        `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`
    );
    expect(offer?.storeHref).toBe(PLAY_STORE_URL);
  });

  it("iOS: the app's own scheme carrying the page, and the App Store on screen", () => {
    const offer = openInAppOffer('https://canari.emse.fr/c/join/tok', UA.messengerIos);

    expect(offer?.openHref).toBe(
      `fr.emse.canari://open?url=${encodeURIComponent('https://canari.emse.fr/c/join/tok')}`
    );
    expect(offer?.storeHref).toBe(APP_STORE_URL);
  });

  it('behind the login redirect, offers the page the visitor came for', () => {
    // An in-app browser has no Canari session, so every visitor from Messenger lands here.
    const offer = openInAppOffer(
      `https://canari.emse.fr/login?returnTo=${encodeURIComponent('/posts/abc?x=1')}`,
      UA.messengerAndroid
    );
    expect(offer?.openHref.startsWith('intent://canari.emse.fr/posts/abc?x=1#Intent;')).toBe(true);

    // A returnTo naming another host is refused, not offered.
    expect(
      openInAppOffer(
        'https://canari.emse.fr/login?returnTo=//example.com/posts/abc',
        UA.messengerIos
      )
    ).toBeNull();
    // A bare /login is not a page of the app.
    expect(openInAppOffer('https://canari.emse.fr/login', UA.messengerIos)).toBeNull();
  });

  it('offers nothing for a path the app does not claim, a foreign page, or a real browser', () => {
    // An intent naming the package matches only the claimed filter: an unclaimed path would send an
    // installed phone to the store.
    expect(
      openInAppOffer('https://canari.emse.fr/auth/callback?code=1', UA.messengerAndroid)
    ).toBeNull();
    expect(openInAppOffer('https://example.com/posts/abc', UA.messengerAndroid)).toBeNull();
    // A Canari name the app does not claim (the dev estate): the intent would miss the filter.
    expect(openInAppOffer('https://dev.canari-emse.fr/posts/abc', UA.messengerAndroid)).toBeNull();
    // The legacy name IS claimed.
    expect(openInAppOffer('https://canari-emse.fr/posts/abc', UA.messengerIos)).not.toBeNull();
    expect(openInAppOffer('https://canari.emse.fr/posts/abc', UA.chromeAndroid)).toBeNull();
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
