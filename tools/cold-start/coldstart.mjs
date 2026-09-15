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
import { adb, deviceSerial, forceStop, launch, logcatDump, waitMs } from './device.mjs';

/** `"09-15 17:45:50.392"` -> ms since midnight. Same day either side, so no date arithmetic. */
function atMs(line) {
  const m = /^\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(line);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

const runs = Number(process.argv[2] ?? 3);
const serial = await deviceSerial();
console.log(`device ${serial}, ${runs} cold start(s)`);

const measured = [];
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
    // A device whose account has no biometric enrolment raises no prompt at all, which is not a
    // fast launch; saying so beats reporting a missing number as a good one.
    for (const l of log.filter((l) => /[Bb]iometric|[Ff]ingerprint/.test(l)).slice(0, 5)) {
      console.log(`    ${l.slice(0, 110)}`);
    }
    continue;
  }
  const ms = atMs(prompt) - atMs(start);
  measured.push(ms);
  console.log(`run ${i}: launch -> prompt ${ms} ms`);
}

await forceStop(serial);
if (measured.length > 0) {
  const lo = Math.min(...measured);
  const hi = Math.max(...measured);
  console.log(`\n${measured.length} run(s): ${lo} - ${hi} ms`);
}
// A run that produced no bracket is a failed measurement, not a slow one.
process.exit(measured.length === runs ? 0 : 1);
