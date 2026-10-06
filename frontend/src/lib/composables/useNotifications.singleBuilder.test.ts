/**
 * ON THE WEB AND ON THE DESKTOP THERE IS EXACTLY ONE THING THAT RAISES A BANNER.
 *
 * G1 (user, 2026-09-18) was two notifications for one salon message on Android, where an FCM push
 * and a WebSocket frame reached two different builders. Android's fix was to make the frame a
 * second TRIGGER for one builder. The question that outlived it was whether the other two surfaces
 * had the same shape, and they cannot: the commands in `src-tauri/src/commands/push.rs` that hand a
 * push token over answer `None` off a phone (asserted below), so a desktop build registers with no
 * push service, and the frontend ships no service worker, so the web can receive no Web Push. On
 * both, the socket frame is the only trigger there has ever been.
 *
 * **THE SECOND TRIGGER IS NOT WHAT THIS TEST WATCHES - the second BUILDER is.** A service worker
 * added for offline caching that also handles `push`, or a component that reaches for
 * `new Notification` directly because it is two lines, recreates the defect without anybody
 * touching the notification code. Both show up here as a second file, which is the one thing a
 * source read can say exactly.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Every way a page or a worker can put a banner on screen in this app. */
const RAISES_A_BANNER = /new Notification\s*\(|\bsendNotification\s*\(|\.showNotification\s*\(/;

const ROOTS = ['src', 'static'];
const SKIP = new Set(['node_modules', 'paraglide', 'wasm', 'proto']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.(ts|js|svelte)$/.test(entry)) continue;
    if (entry.endsWith('.test.ts')) continue;
    yield full;
  }
}

describe('the web and the desktop have ONE notification builder', () => {
  it('nothing outside useNotifications raises a banner', () => {
    const raisers: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(process.cwd(), root))) {
        if (RAISES_A_BANNER.test(readFileSync(file, 'utf8'))) {
          raisers.push(relative(process.cwd(), file).split(sep).join('/'));
        }
      }
    }

    // A second entry here is a second builder, whatever raised it - a service worker handling
    // `push`, or a component reaching for `new Notification` because it is two lines.
    expect(raisers).toEqual(['src/lib/composables/useNotifications.svelte.ts']);
  });
});

/**
 * THE TRIGGER HALF, read out of the Rust source. A desktop build has no push token because the two
 * commands that hand one to the frontend answer `None` off a phone; were either to grow a desktop
 * branch, a desktop client would register for pushes and a pushed message would reach its one
 * builder twice - the G1 shape - with no notification code touched.
 */
describe('the desktop hands over no push token', () => {
  const pushRs = readFileSync(join(process.cwd(), 'src-tauri/src/commands/push.rs'), 'utf8');

  /** The body of `fn <name>`, up to the next top-level item. */
  function body(name: string): string {
    const start = pushRs.indexOf(`fn ${name}(`);
    expect(start, `fn ${name} not found in push.rs`).toBeGreaterThan(-1);
    const end = pushRs.indexOf('\n}\n', start);
    return pushRs.slice(start, end);
  }

  it.each([
    ['get_fcm_token', 'any(target_os = "android", target_os = "ios")'],
    ['get_voip_token', 'target_os = "ios"'],
  ])('%s answers None off a phone', (name, mobile) => {
    const fn = body(name);
    const offPhone = new RegExp(
      `#\\[cfg\\(not\\(${mobile.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\)\\)\\]\\s*\\{\\s*let _ = app;\\s*None\\s*\\}`
    );

    expect(fn).toContain(`#[cfg(${mobile})]`);
    expect(fn).toMatch(offPhone);
  });
});
