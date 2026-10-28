import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CUSTOM-SCHEME HOSTS A PUSH CAN CARRY MUST BE DECLARED IN `tauri.conf.json`.
 *
 * The Android deep-link plugin drops every intent whose URL does not match a `plugins.deep-link.mobile`
 * entry (`isDeepLink` in `DeepLinkPlugin.kt`), in BOTH `onNewIntent` (app running) and `load` (cold
 * start). The notification's own `PendingIntent` is explicit, so it needs no manifest filter - but its
 * `VIEW` data still goes through that plugin check. Measured on a Mi 9T on 2026-10-08: a calendar and
 * an admin-agenda push opened the app and changed nothing, backgrounded or killed, because only
 * `callback`, `stripe`, `chat`, `post` and `form` were declared. `posts` and `proposals` were in the
 * same position.
 */
const SERVER_HOSTS = [
  'chat',
  'post',
  'form',
  'posts',
  'calendar',
  'admin-agenda',
  'proposals',
  'live',
  // D38b: the author's inbox of republication requests.
  'republication-requests',
  // WP-F4: the reader's inbox of follow requests.
  'follow-requests',
  // WP-L8b: a cut live, a suspension, a withdrawal - the notifications list, where their row is.
  'notifications',
  // The organiser alert (a payment landed on a full form): that form's responses.
  'form-responses',
];

/** The checkout return. `stripe`, its name in builds below 1.2.4, is retired. */
const CHECKOUT_HOSTS = ['payment'];

/** Hosts retired with `minClientVersion` 1.2.7, refused by the server. */
const RETIRED_HOSTS = ['stripe'];

/**
 * MiConnect's way back from a sign-out (`OIDC_MOBILE_POST_LOGOUT_URI`). Opened by the Custom Tab, not
 * by an explicit intent, so on Android it needs the MANIFEST filter as well: without it Chrome finds
 * no app for the URL, the tab stays open on MiConnect, and the sign-out reads as stuck.
 */
const BROWSER_RETURN_HOSTS = ['signed-out'];

describe('custom-scheme deep-link hosts', () => {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8')
  ) as { plugins: { 'deep-link': { mobile: { scheme: string[]; host?: string }[] } } };
  const declared = conf.plugins['deep-link'].mobile
    .filter((e) => e.scheme.includes('fr.emse.canari'))
    .map((e) => e.host);

  it.each([...SERVER_HOSTS, ...CHECKOUT_HOSTS, ...BROWSER_RETURN_HOSTS])(
    'declares fr.emse.canari://%s',
    (host) => {
      expect(declared).toContain(host);
    }
  );

  // The server hosts too: the committed manifest carries one filter per declared host (#1635), and
  // a host declared above with no filter here is a manifest that was not regenerated with it.
  it.each([...SERVER_HOSTS, ...CHECKOUT_HOSTS, ...BROWSER_RETURN_HOSTS])(
    'the Android manifest filters fr.emse.canari://%s too',
    (host) => {
      const manifest = readFileSync(
        resolve(__dirname, '../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
        'utf8'
      );
      expect(manifest).toContain(`android:host="${host}"`);
    }
  );

  /**
   * A RETIRED host must not come back by a regen: the server refuses it, so an app that registered
   * it again would catch a URL nothing legitimate emits.
   */
  it.each(RETIRED_HOSTS)('declares fr.emse.canari://%s nowhere', (host) => {
    const manifest = readFileSync(
      resolve(__dirname, '../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    expect(declared).not.toContain(host);
    expect(manifest).not.toContain(`android:host="${host}"`);
  });
});
