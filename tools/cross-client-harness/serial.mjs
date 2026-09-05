/**
 * WHICH PHONE adb SHOULD TALK TO - one resolver, and it REFUSES TO GUESS between two of them.
 *
 * **WHY THIS IS ITS OWN MODULE AND NOT A FUNCTION IN `phone.mjs`.** There were TWO resolvers with
 * OPPOSITE policies, and the second one was invisible: `phone.mjs`'s `serial()` honours
 * `ANDROID_SERIAL` and throws on ambiguity, while `watch.mjs` carried a private `resolveSerial()`
 * that ignored `ANDROID_SERIAL` entirely and silently returned `lines[0]`. With two phones attached
 * - a Pixel 6a beside the Mi 9T on 2026-09-04 - `useDevice('A2')` would bind every GESTURE to the
 * Pixel while `logcatSince` read the Mi 9T's log, and the row would gather its evidence from the
 * wrong device and say nothing. An instrument answering about a different subject than the one under
 * test is the campaign's worst failure mode, and it is the reason `estate.mjs` exists too.
 *
 * The obvious fix - have `watch.mjs` import `phone.mjs` - is not available, and the reason decides
 * the shape of this file. `phone.mjs` imports the out-of-tree `names.mjs` (the name -> serial map is
 * a set of DEVICE IDS and this repository is PUBLIC), `names.mjs` is gitignored, and `watch.mjs` is
 * reachable from two gated self-tests. Importing it would make `watch.mjs` unimportable on a fresh
 * checkout and fail `make test-harness` on CI - which `gate-selftest.mjs` exists to catch.
 *
 * So the TRANSPORT question splits from the IDENTITY question, exactly as `estate.mjs` splits from
 * `ssh.mjs` and for the same reason: **this file is machine-agnostic and imports nothing local**,
 * while the `A1`/`A2` -> serial mapping stays in `phone.mjs` where `names.mjs` may be reached.
 */
import { execFileSync } from 'node:child_process';

/** Every device adb currently lists as `device`, in the order adb gives them. */
export function attached() {
  const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
}

/**
 * The one phone this process is about, or a throw naming what to do about it.
 *
 * THIS PICKED THE WRONG PHONE THE MOMENT A SECOND ONE WAS PLUGGED IN. It took the first USB entry,
 * on the assumption - true for a year - that there was only ever one; on 2026-09-04 a Pixel 6a was
 * attached beside the Mi 9T and it answered the PIXEL, because adb happened to list it first.
 * Nothing would have failed: every atom would have woken, forwarded, logged into and measured a
 * phone the run was not about, and reported confidently about A1.
 *
 * So ambiguity is an ERROR rather than a choice, and there are exactly two ways to resolve it, both
 * explicit: `ANDROID_SERIAL` - adb's OWN convention, so it also reaches any adb this rig shells out
 * to - or `useDevice()` in `phone.mjs`, from a named device. A wireless entry is preferred last,
 * because the LIFE phase cuts the radios.
 *
 * IT THROWS, AND A READER OF LOGS MUST NOT. A gesture that cannot tell which phone it is driving has
 * to stop; a REPORT that cannot has to say so and let the row carry on, because a crashed observer
 * destroys the measurement it was gathering. `logcatSince` therefore catches this and returns the
 * refusal as its first line rather than propagating it.
 */
export function serial() {
  const ids = attached();
  if (!ids.length) throw new Error('no adb device');

  const named = process.env.ANDROID_SERIAL;
  if (named) {
    if (!ids.includes(named)) {
      throw new Error(`ANDROID_SERIAL=${named} is not attached - adb lists: ${ids.join(' ')}`);
    }
    return named;
  }

  const usb = ids.filter((id) => !id.includes(':'));
  const pool = usb.length ? usb : ids;
  if (pool.length > 1) {
    throw new Error(
      `${pool.length} phones are attached (${pool.join(' ')}) and nothing says which this is about. ` +
        `Name one: ANDROID_SERIAL=<serial>, or pass --device to an atom so it can call useDevice(). ` +
        `Choosing for you drives the wrong phone and still reports success.`,
    );
  }
  return pool[0];
}
