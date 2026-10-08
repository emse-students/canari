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
const SERVER_HOSTS = ['chat', 'post', 'form', 'posts', 'calendar', 'admin-agenda', 'proposals'];

describe('custom-scheme deep-link hosts', () => {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8')
  ) as { plugins: { 'deep-link': { mobile: { scheme: string[]; host?: string }[] } } };
  const declared = conf.plugins['deep-link'].mobile
    .filter((e) => e.scheme.includes('fr.emse.canari'))
    .map((e) => e.host);

  it.each(SERVER_HOSTS)('declares fr.emse.canari://%s', (host) => {
    expect(declared).toContain(host);
  });
});
