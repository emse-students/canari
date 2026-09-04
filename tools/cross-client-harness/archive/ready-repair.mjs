/**
 * BRINGING ONE DEVICE TO A NAMED STARTING POINT - the half of the readiness probe that acts.
 *
 * SPLIT FROM `ready-probe.mjs` BY A GITIGNORE, and the seam is honest: reading a device needs its
 * port from `names.mjs`, which is gitignored because it holds real display names and this repository
 * is PUBLIC. So the PREDICATE lives next door where a CI self-test can import it, and everything that
 * needs a browser lives here. Read that file's header for why either exists at all.
 */
import { spawn } from 'node:child_process';
import { clearOverlays, client, evaluate } from '../chat.mjs';
import { ORIGIN, PORTS } from '../names.mjs';
import { HARNESS_ROOT, requireScript } from '../scriptpath.mjs';
import { MAX_REPAIR_PASSES, READY_EXPR, isReady, stateOf } from './ready-probe.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one of this rig's own scripts to completion, resolving to its exit code.
 *
 * `stdio: 'ignore'` because the caller narrates the repair itself; the script's own output would
 * interleave with a phase's report and say the same thing twice.
 *
 * **THE PATH IS RESOLVED, AND IT USED TO BE A BARE NAME AGAINST THIS DIRECTORY.** `pin.mjs` lives at
 * the harness root and this file lives in `archive/`, so the spawn failed with `Module not found`
 * every single time - and `stdio: 'ignore'` swallowed the message while nothing read the exit code.
 * The preflight therefore printed `fix PIN gate is up - unlocking` four times, changed nothing, and
 * declared the client NOT FIT TO MEASURE. Measured 2026-09-04 on W1, W2 and A1, while `bun pin.mjs
 * --device <d>` typed in the same PIN by hand in under two seconds.
 */
export const runScript = (args) =>
  new Promise((resolve) => {
    const [name, ...rest] = args;
    const c = spawn(process.execPath, [requireScript(name), ...rest], {
      cwd: HARNESS_ROOT,
      stdio: 'ignore',
    });
    c.on('close', resolve);
  });

/** Reads a client's state, or throws if nothing is listening. */
export async function readiness(d) {
  const cx = await client(PORTS[d], null, { focus: false });
  try {
    return JSON.parse(await evaluate(cx, READY_EXPR));
  } finally {
    cx.close();
  }
}

/**
 * Re-reads a client until it is ready, or until the deadline - whichever comes first.
 *
 * Returns the LAST state it managed to read, including an unready one, because the caller's repair
 * loop needs to know what it is still looking at in order to choose the next repair. `null` only
 * when the client never answered at all inside the window.
 */
export async function settle(d, deadlineMs) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const s = await readiness(d).catch(() => null);
    if (s) {
      last = s;
      if (isReady(s)) return s;
    }
    if (Date.now() - t0 >= deadlineMs) return last;
    await sleep(300);
  }
}

/** Dismisses whatever covers the screen, and NAMES it. The repair is `clearOverlays`, imported. */
async function dismissOverlay(d, log) {
  const cx = await client(PORTS[d], null, { focus: false });
  try {
    const cleared = await clearOverlays(cx);
    for (const o of cleared)
      log(`       ${d} ${o.stuck ? 'STUCK' : 'cleared'} ${o.kind}${o.label ? ` (${o.label})` : ''}`);
  } finally {
    cx.close();
  }
}

/**
 * Brings ONE device to a named starting point, repairing loudly, and says what it ended as.
 *
 * THE REPAIRS ARE EXPECTED, NOT EXCEPTIONAL - a fresh tab starts at the PIN gate, a client left on
 * `/posts` cannot prove it is unlocked because the gate does not mount there, and a row that revokes
 * or logs a device out leaves it with no session at all - so refusing over any of them would just
 * move a manual step from one place to another. All four are repaired.
 *
 * They are repaired LOUDLY. A silent repair would hide the thing worth knowing: which check left the
 * instrument in that state. TYPE-3 closes a tab by design and W1 comes back locked; that is fine and
 * it should be visible, because the day it is something else, the line is the only warning.
 *
 * Returns `{ ok, state, trail }`, or `{ ok: false, unreachable }` when nothing ever answered - the
 * caller decides whether that refuses a phase, fails a row, or is simply reported, because only the
 * caller knows what the device was wanted FOR. Nothing here pushes to anybody's `problems[]`.
 *
 * @param {string} d Device label - `W1`, `A1`, ...
 * @param {{ log?: (s: string) => void }} [opts] `log` defaults to `console.log`; pass a sink to run quiet.
 */
export async function bringToReady(d, { log = console.log } = {}) {
  let s;
  try {
    s = await readiness(d);
  } catch (e) {
    return { ok: false, state: null, trail: [], unreachable: e instanceof Error ? e.message : String(e) };
  }

  const trail = [stateOf(s)];
  for (let pass = 0; pass < MAX_REPAIR_PASSES && !isReady(s); pass++) {
    // How long this pass will keep asking. It is a DEADLINE, not a delay: `settle` returns the
    // moment the client is ready, so a repair that works instantly costs nothing. The numbers
    // below used to be `sleep`s, which charged their full value to every repair including the
    // ones that had already succeeded - and this loop runs before EVERY job in a phase.
    let deadlineMs = 8000;
    // AN OVERLAY IS DEBRIS UNLESS IT IS THE GATE, and this used to be asked only of an UNLOCKED
    // client - which left it blocking the one repair that needs a click as much as any check does.
    // Measured on W1, 2026-08-28: the PIN dialog sat over /login, so the state was signedOut+overlay,
    // 'login.mjs' could not reach "Se connecter", and four passes changed nothing. Escape closed the
    // dialog on the first try and the login page was clickable immediately afterwards.
    //
    // 'LOCKED' IS THE ONE EXCLUSION AND IT IS THE WHOLE REASON THE NARROW TEST EXISTED: there the
    // overlay IS the gate, and dismissing it would close the prompt the unlock repair has to answer.
    // Stating it as "unless it is the gate" rather than enumerating the states that need a click
    // keeps one clause instead of a list to keep in sync.
    if (s.overlay && s.locked !== 'LOCKED') {
      log(`  fix  ${d.padEnd(3)} ${s.overlay} overlay(s) still up on ${s.path} (${s.locked}) - dismissing`);
      await dismissOverlay(d, log);
      deadlineMs = 3000;
    } else if (s.locked === 'signedOut') {
      // THE ONE REPAIR THIS LOOP DID NOT HAVE, and its absence was not a missing convenience: no
      // other baseline in the rig restores a session. `launch.mjs start` no-ops on a browser that is
      // already running and `pin.mjs` answers a gate a logged-out client never mounts, so a device
      // left signed out could not be brought to a named starting point by anything here.
      //
      // `login.mjs` is idempotent by reading before acting and usually costs no credential at all -
      // the SSO cookies live on auth.canari-emse.fr and cas.emse.fr, which wiping the app's origin
      // does not touch. The deadline is the widest in this loop because this repair is a full OIDC
      // round trip, not a click.
      log(`  fix  ${d.padEnd(3)} on ${s.path} with no session - signing it back in`);
      await runScript(['login.mjs', '--device', d]);
      deadlineMs = 40000;
    } else if (s.locked === 'unknown') {
      log(`  fix  ${d.padEnd(3)} on ${s.path}, where the PIN gate does not mount - sending it to /chat`);
      const cx = await client(PORTS[d], null, { focus: false });
      // ORIGIN[d], never SITE: the phone's app is served from `tauri.localhost`, and sending its
      // WebView to the public site leaves the app rather than reloading it - the Tauri plugin
      // allowlist is scoped to that origin, so every request then fails silently and the client
      // reads as stuck. This preflight would have done it on EVERY run touching A1.
      await evaluate(cx, `location.href = ${JSON.stringify(`${ORIGIN[d]}/chat`)}`);
      cx.close();
      deadlineMs = 20000;
    } else if (s.locked === 'booting') {
      // Nothing to repair - the app is coming up. Acting here would type a PIN into a page that
      // has not raised the prompt yet, and then read the failure as the client's.
      log(`  wait ${d.padEnd(3)} on ${s.path}, no gate and nothing rendered yet - still booting`);
      deadlineMs = 20000;
    } else {
      log(`  fix  ${d.padEnd(3)} PIN gate is up - unlocking`);
      // THE EXIT CODE IS READ, AND NOT READING IT IS WHAT MADE THE BREAKAGE ABOVE INVISIBLE. A
      // repair that could not run is not the same fact as a repair that ran and did not help: the
      // first accuses this file, the second accuses the client. Saying which costs one line.
      const code = await runScript(['pin.mjs', '--device', d]);
      if (code !== 0) log(`  FAIL ${d.padEnd(3)} pin.mjs exited ${code} - the repair did not run`);
      deadlineMs = 10000;
    }
    s = (await settle(d, deadlineMs)) ?? s;
    trail.push(stateOf(s));
  }

  return { ok: isReady(s), state: s, trail };
}
