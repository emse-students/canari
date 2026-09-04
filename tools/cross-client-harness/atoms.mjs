/**
 * THE ATOMS - every gesture this rig can make, in one place, each with its contract.
 *
 * WHY THIS FILE EXISTS. The rig is ~150 files and about twenty of them are GESTURES - log a client
 * in, answer the PIN, open a DM, create a group, add a member, mint a device the server has never
 * seen - while the rest are ROWS that compose those gestures into a question. Until this file there
 * was no way to see that split: a session picking the rig up read `checks.mjs` (which lists rows,
 * not gestures) or grepped, and the third `createGroup` got written because the first two were not
 * findable. Three copies of one gesture is three places for a post-condition to rot, and that is
 * exactly what `groupnav.mjs` records happening - `newgroup.mjs`, `del1.mjs` and READ-10 each held a
 * lesson the other two were missing.
 *
 * **AN ATOM IS DEFINED BY THREE PROPERTIES, AND A GESTURE THAT LACKS ONE IS NOT ONE YET.**
 *
 *  1. **It ends on a fact, never on a clock.** `createDM` returns when the SIDEBAR names the
 *     contact; `login` returns when the app has committed to a session; `pin` returns when the gate
 *     is gone or an error is on screen. A sleep is a bound on a wait, never the wait itself.
 *  2. **It is idempotent, and it reads before it acts.** Called twice, the second call is a read.
 *     `createDM` skips the whole modal when the row is already listed, `login` exits when the client
 *     already holds a session, `venue` runs four `SELECT`s. A row can therefore start from whatever
 *     the previous row left behind, which is rule 4 of the campaign.
 *  3. **It addresses the product structurally, not by pixel and not by wording.** A submit button is
 *     `form button[type=submit]`, an autocomplete option is `[role="option"]` reached with the arrow
 *     keys, a tab is `APP_TAB`. THE RIG DRIVES PHONES OF SEVERAL SIZES AND ONE LOCALE MAY CHANGE:
 *     a coordinate that was right on one screen is wrong on the next, and a French label is not an
 *     API. Where a real pointer sequence IS the thing under test, `realClick` re-measures the centre
 *     at the moment it clicks - that is adaptive, not fixed.
 *
 * **NOTHING HERE IS A ROW.** An atom takes no verdict, records nothing in `results.ndjson` and
 * asserts nothing about the application. That is what makes it reusable: a row decides what a
 * gesture's outcome MEANS, and two rows may read the same outcome differently.
 *
 * **WITH EXACTLY ONE EXCEPTION, AND IT IS DELIBERATE: `newdevice.mjs`.** It imports `recordObserved`
 * and closes `HEAL-NEW-0`. That is not a filing mistake to be tidied away - ten HEAL-NEW rows reach
 * it with `--keep-open` and rest on the device it builds, so the primitive is measured by a row of
 * its own and a failure inside it is attributed to IT rather than surfacing as ten unrelated rows
 * failing for reasons none of them owns. A gesture load-bearing enough that other rows depend on it
 * earns a row proving it works; nothing else here does.
 *
 * **The boundary is machine-checked rather than trusted, since 2026-09-04.** `inventory.mjs` asks
 * every script whether it imports a verdict writer from `results.mjs` and files it on the answer, so
 * a second atom growing a `record(...)` shows up in `INVENTORY.md` under "Primitives that carry
 * their own row" on the next `make test-harness` rather than quietly contradicting this paragraph.
 * The audit that produced this note (work item A3) found the reverse error to be the common one:
 * 39 GESTURES were filed under `archive/` and announced as rows, where nobody looking for a gesture
 * would find them - which is the duplication this whole rig was being tidied to stop.
 *
 * **TWO SHAPES, AND THE REASON IS HISTORICAL RATHER THAN PRINCIPLED.** Some atoms are importable
 * functions (`createDM`, `createGroup`, `client`, `psql`); some are CLI scripts with top-level
 * `await` (`login.mjs`, `pin.mjs`, `newdevice.mjs`), which a bigger script reaches by spawning -
 * which is what `newdevice.mjs` does today. Converting the second group into functions with a thin
 * CLI wrapper is worth doing and is NOT done here: it changes the process model of every runner that
 * spawns them, and that belongs in its own change rather than riding along with a fix. `run()` below
 * is the ONE way to call the CLI shape from JavaScript in the meantime, so no caller has to
 * re-derive the argument spelling.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INVENTORY. Everything the rig can do to a client, by what it is for.
 *
 * **The estate** - where the campaign runs, and it is one constant.
 *   `SITE`            `names.mjs`  the absolute URL of the estate under test. Changing it moves the
 *                                  campaign; everything below derives from it and nothing spells a
 *                                  host.
 *   `APP_TAB`         `chat.mjs`   the substring that identifies the app's own tab (host + port).
 *   `APP_HOST`        `chat.mjs`   the hostname alone, for a cookie's `domain`, which has no port.
 *   `psql` `redis`    `estate.mjs` the estate's database and Redis - LOCAL containers or production
 *                                  through the tunnel, decided by `SITE`, never by a flag. Its own
 *                                  module because `ssh` is machine-agnostic and an ESTATE is not.
 *
 * **THE ROWS ARE NO LONGER BESIDE THE ATOMS.** Since 2026-09-04 the ~114 row scripts live in
 * `archive/` and only atoms remain at this root, so `ls` answers the question this file was written
 * because a grep could not. Nothing was deleted; a row reaches a library that stayed behind by `../`.
 * See `archive/README.md`.
 *
 * **Bringing a client up**
 *   `startBrowser` `killBrowser`   `launch.mjs`   a Chrome profile IS a device; the profile lives
 *                                                 outside the work tree.
 *   `bun login.mjs --device W1`                  the two IdP paths: Authentik's service-account
 *                                                 flow (default) and the school's CAS (`--flow cas`).
 *   `bun login.mjs --android`                     the same on the phone, ARMING what it needs -
 *                                                 `--android` is `--device A1`, and it wakes,
 *                                                 launches, foregrounds and forwards before it looks
 *                                                 at anything. It answers the form in the phone's
 *                                                 BROWSER first and touches the app only after the
 *                                                 submit, because Android freezes the app while the
 *                                                 form is in front. It ends on the session the app
 *                                                 writes, never on a URL.
 *   `useDevice('A1')`               `phone.mjs`   WHICH phone, when more than one is attached. A
 *                                                 device selector that picks "the first" is silently
 *                                                 wrong at two, so ambiguity throws; this and adb's
 *                                                 own `ANDROID_SERIAL` are the two ways out.
 *   `bun a1apk.mjs`                               build the debug APK, install it, prove the origin
 *                                                 it points at - and it is the ONLY build that adds
 *                                                 the `local-estate` capability, without which the
 *                                                 phone refuses the estate it was pointed at.
 *   `bun pin.mjs --device W1`                    the encryption gate, in BOTH its shapes - the
 *                                                 returning "Deverrouiller" and the first-run
 *                                                 "Creer mon PIN" - and both keyboard shapes, the
 *                                                 desktop input and the mobile keypad.
 *   `bun unlock.mjs`                             the phone's PIN after any relaunch or reinstall.
 *   `bun phone.mjs`                              the A1 forward, derived from the running pid.
 *   `client(port, APP_TAB)`         `chat.mjs`    attach to a client and refuse an ambiguous tab.
 *
 * **Making a device**
 *   `bun newdevice.mjs [--keep-open]`            turns W3 into a device the server has never seen,
 *                                                 and MEASURES that it did. Destructive, so it has
 *                                                 an allowlist (`WIPEABLE`), not a denylist.
 *   `bun purge-devices.mjs --only <id>`          removes a device through the product's own panel.
 *
 * **Building the venue and the conversations**
 *   `bun venue.mjs`                              the shared community and its channel, idempotent,
 *                                                 answered from the tables rather than the screen.
 *   `createDM(cx, name)`            `groupnav.mjs`  a DM with someone, created if absent.
 *   `createGroup(cx, name)`         `groupnav.mjs`  a group conversation.
 *   `bun invite.mjs --port <p> --group <name>`     adds a member - the campaign's only cheap,
 *                                                   deterministic epoch generator.
 *   `deleteGroup` `dismissLocally`  `groupnav.mjs`  the two ways a conversation ends.
 *
 * **Navigating and speaking**
 *   `ensureChat` `goto` `openDM` `openConversation` `openChannel`   `chat.mjs` / `groupnav.mjs`
 *   `send(cx, text)` `armComposer` `fireComposer`                   `chat.mjs`
 *   `hoverBubble` `longPressBubble` `clickBubbleAction`             `chat.mjs` - desktop and mobile
 *                                                                   shapes of the same gesture.
 *
 * **Observing**
 *   `watch(cx)`                     `watch.mjs`    console, page errors, HTTP and WebSocket, with
 *                                                  the classifier every row reports next to its
 *                                                  verdict. Expected noise is dispositioned PER ROW
 *                                                  with `ignoringExpectedLog`, never widened here.
 *   `srvlog.mjs` `state.mjs` `rows.mjs`            the server window, what the clients are, and the
 *                                                  board against the ledger.
 * ---------------------------------------------------------------------------------------------
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export { APP_HOST, APP_TAB, client, ensureChat, goto, openConversation, openDM, send } from './chat.mjs';
export { createDM, createGroup, deleteGroup, dismissLocally, openGroup } from './groupnav.mjs';
export { BROWSERS, isUp, killBrowser, startBrowser } from './launch.mjs';
export { ORIGIN, PORTS, SITE, VENUE } from './names.mjs';
export { psql, redis } from './estate.mjs';
export { ssh } from './ssh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Runs one of the CLI-shaped atoms and returns what it printed, with its exit code.
 *
 * ONE SPELLING OF THE ARGUMENTS, IN ONE PLACE. Every caller that spawns `login.mjs` or `pin.mjs`
 * has to know that the device is passed as `--device W3` and not `--port`, that a credential is
 * never an argv value, and that a non-zero exit is not always a failure - `pin.mjs` exits 2 for
 * "no gate to answer", which is a legitimate outcome on a client that is already unlocked. Every
 * caller getting that right independently is how the rig grows two subtly different ways of doing
 * the same thing.
 *
 * `stdio: 'pipe'` and the output RETURNED rather than inherited, because a caller that wants to
 * classify what an atom said cannot do it from the terminal. Callers that want it on screen print
 * it themselves - which also keeps the ordering of a composed run readable.
 *
 * @param script the file name, e.g. `'login.mjs'`
 * @param args   the arguments, already split
 * @returns `{ code, out }` - the exit code and stdout+stderr joined
 */
export function run(script, args = [], { timeoutMs = 300_000 } = {}) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: 'pipe',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** `bun login.mjs --device <device>`, with the flow the campaign's accounts use. */
export const login = (device, { flow = 'service-account' } = {}) =>
  run('login.mjs', ['--device', device, '--flow', flow]);

/**
 * `bun pin.mjs --device <device>`.
 *
 * EXIT 2 IS AN ANSWER, NOT A FAILURE: it means no gate was on screen, which is either a client
 * already past it or one that never mounted it - and `pin.mjs` prints which. Callers decide.
 */
export const pin = (device, extra = []) => run('pin.mjs', ['--device', device, ...extra]);
