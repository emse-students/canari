/**
 * LAUNCH TO FINGERPRINT PROMPT, ON A REAL ANDROID HANDSET.
 *
 * The number this repo's cold-start work is judged on, and the reason it is measured here rather
 * than in a gate: an APK EMBEDS its frontend (`frontendDist: "../build"`), so no deploy reaches
 * one, and every part of the launch that matters - the WebView booting, the keystore, the
 * BiometricPrompt - exists only on a device.
 *
 * Two lines of `logcat` bracket it. `ActivityTaskManager: START u0 ... fr.emse.canari` is the
 * launch; `BiometricService ... handleAuthenticate` is the prompt reaching the system server. THE
 * PROMPT IS NEVER ANSWERED: the app is force-stopped between runs, so every run is genuinely cold
 * and no unlocked session leaks into the next one.
 *
 * Usage: `bun tools/cold-start/coldstart.mjs [runs]` (default 3).
 */
import { adb, deviceSerial, forceStop, isRunning, launch, logcatDump, waitMs } from './device.mjs';

/** `"09-15 17:45:50.392"` -> ms since midnight. Same day either side, so no date arithmetic. */
function atMs(line) {
  const m = /^\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(line);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/**
 * WHY A RUN PRODUCED NO BRACKET - a different question from how slow the launch was, and the one
 * this tool used to leave to the reader.
 *
 * `run 1: no bracket - START=true PROMPT=false` is true and nearly useless: it took six manual adb
 * commands on 2026-09-15 to learn that the handset was simply SIGNED OUT, which no amount of
 * re-running would have changed. The evidence separating the causes was already in the logcat dump
 * the tool had in hand. So it says which one it is, because a report that cannot distinguish its
 * causes sends its reader to do the work by hand.
 *
 * THE DISCRIMINATOR IS WHAT THE APP ASKED THE SYSTEM SERVER, IN ORDER:
 *
 * - the process is gone, or `AndroidRuntime` named it -> it CRASHED; nothing here is about speed.
 * - no `canAuthenticate` at all -> the app never reached the unlock decision.
 * - `canAuthenticate` answered something other than OK -> the system server would have refused the
 *   prompt. The code is printed rather than translated: only `Status: 1` is asserted here, because
 *   only that one has been observed against a handset known to have an enrolled fingerprint, and a
 *   mapping copied from memory is exactly the kind of table that goes quietly wrong.
 * - `canAuthenticate` answered OK and the app still did not prompt -> it REACHED the decision, could
 *   have prompted, and chose not to. On this client that means there is no session to unlock: the
 *   refresh credential was refused and `sessionAuth` latches rather than asking for a PIN it cannot
 *   use ("PIN prompt declined - refresh credential already proven dead"). Sign the handset in.
 *
 * The first three and the fourth are all PRECONDITIONS, not measurements, and none of them changes
 * between runs - so the caller stops rather than spending 23 s a run to be told the same thing.
 */
function diagnoseMissingPrompt(log, alive) {
  if (!alive || log.some((l) => /AndroidRuntime.*fr\.emse\.canari|FATAL EXCEPTION/.test(l))) {
    return { cause: 'the app CRASHED or exited before the prompt', standing: true };
  }
  const status = log
    .map((l) => /PreAuthInfo.*AuthenticatorStatus: (\d+)/.exec(l))
    .filter(Boolean)
    .at(-1);
  if (!status) {
    return {
      cause:
        'the app never asked whether biometrics are available, so it never reached the unlock decision',
      standing: true,
    };
  }
  if (status[1] !== '1') {
    return {
      cause: `the system server would refuse the prompt - PreAuthInfo AuthenticatorStatus: ${status[1]} (1 is the only value observed as usable; check enrolment, lockout and device policy)`,
      standing: true,
    };
  }
  return {
    cause:
      'THE HANDSET IS SIGNED OUT. Biometrics are usable and the app reached the unlock decision, ' +
      'then declined to prompt - which on this client means the refresh credential was refused and ' +
      'there is no session to unlock. Sign in on the device, then measure.',
    standing: true,
  };
}
const runs = Number(process.argv[2] ?? 3);
const serial = await deviceSerial();
console.log(`device ${serial}, ${runs} cold start(s)`);

const measured = [];
/** Set when a run failed on a PRECONDITION rather than on speed - it decides the closing line. */
let failure = null;
for (let i = 1; i <= runs; i++) {
  await forceStop(serial);
  // The process has to be gone, not merely asked to go: a launch into a dying process measures
  // the teardown as well.
  await waitMs(3000);
  await adb(serial, ['logcat', '-c']);
  await launch(serial);
  await waitMs(20000);

  const log = await logcatDump(serial);
  const start = log.find((l) => /ActivityTaskManager.*START u0 .*fr\.emse\.canari/.test(l));
  const prompt = log.find((l) => /BiometricService.*handleAuthenticate/.test(l));
  if (!start || !prompt) {
    console.log(`run ${i}: no bracket - START=${!!start} PROMPT=${!!prompt}`);
    const { cause, standing } = diagnoseMissingPrompt(log, await isRunning(serial));
    console.log(`    ${cause}`);
    // A precondition does not improve by being re-measured. Stopping here also leaves the app
    // RUNNING and in the state that failed, which is what anyone fixing it needs to look at.
    if (standing) {
      failure = cause;
      break;
    }
    continue;
  }
  const ms = atMs(prompt) - atMs(start);
  measured.push(ms);
  console.log(`run ${i}: launch -> prompt ${ms} ms`);
}

// A precondition failure leaves the app up deliberately: the state that refused to prompt is the
// state worth looking at, and force-stopping it discards the only copy.
if (!failure) await forceStop(serial);
if (measured.length > 0) {
  const lo = Math.min(...measured);
  const hi = Math.max(...measured);
  console.log(`\n${measured.length} run(s): ${lo} - ${hi} ms`);
}
if (failure) {
  console.log(`\nNOT MEASURED - ${failure}`);
  console.log('This is a precondition, not a slow launch: re-running changes nothing.');
}
// A run that produced no bracket is a failed measurement, not a slow one.
process.exit(measured.length === runs ? 0 : 1);
