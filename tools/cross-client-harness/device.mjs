/**
 * WHICH CLIENT AN ATOM IS ABOUT, resolved once, in one place.
 *
 * WHY IT EXISTS: I WROTE THE SECOND COPY THE SAME DAY I WROTE THE FIRST. `login.mjs` gained
 * `--android`, `useDevice` and `ensure` on 2026-09-04; an hour later `pin.mjs` needed exactly the
 * same twelve lines and got them by copy. That is the duplication the user reported - *"tu as
 * recode des choses qui existaient deja"* - happening in real time, and a third command (`send.mjs`)
 * was about to make it three. Two copies of a resolver is two places for the phone-arming ladder to
 * drift, and a drift there means two atoms disagreeing about WHICH PHONE they are driving.
 *
 * IT RESOLVES, IT DOES NOT PARSE THE WORLD. Given the argv of any atom it answers the same four
 * questions - which named device, on which devtools port, as which account, and is it a phone - and
 * arms the phone when it is one. Nothing else belongs here: a gesture is not a device.
 *
 * **A DEVICE NAME CARRIES ITS PLATFORM.** `W1`/`W2`/`W3` are Chrome profiles, `A1`/`A2` are Android.
 * It is a convention rather than a probe on purpose: which client a run is about must be decidable
 * BEFORE anything is plugged in or woken, and asking adb what is attached cannot answer a question
 * about intent.
 */
import { ACCOUNT_OF, PORTS } from './names.mjs';
import { ensure, useDevice } from './phone.mjs';

/** `A1`, `A2`, ... - the rig's spelling for "this client is an Android app". */
export const isPhoneName = (name) => /^A\d+$/.test(name ?? '');

/**
 * Reads `--device` / `--android` / `--port` / `--account` out of an argv, without arming anything.
 *
 * `--android` IS `--device A1`, and it contradicts a `--device` naming anything else rather than
 * silently winning: a run that says two different things about its target has a bug in the caller,
 * and guessing which half was meant is how the wrong phone gets driven.
 *
 * THE ACCOUNT IS DERIVED FROM THE DEVICE, never defaulted to a spelt key. A spelt key is an identity
 * in a public repository, and it is the wrong answer the moment the same command is pointed at the
 * other browser - the login then fails on credentials that are perfectly correct for someone else.
 *
 * @param argv typically `process.argv.slice(2)`
 * @param defaultPort the port to assume when nothing names a device (the historical W2 default)
 */
export function resolveDevice(argv, { defaultPort = PORTS.W2 } = {}) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };

  const android = argv.includes('--android');
  const spelt = opt('device', null);
  if (android && spelt && spelt !== 'A1') {
    throw new Error(`--android IS --device A1, so --device ${spelt} contradicts it`);
  }
  const device = android ? 'A1' : spelt;
  if (device && !PORTS[device]) {
    throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);
  }

  const port = Number(opt('port', device ? PORTS[device] : defaultPort));
  const forPort = Object.keys(PORTS).find((d) => PORTS[d] === port);
  const account = opt('account', device ? ACCOUNT_OF[device] : ACCOUNT_OF[forPort]);

  return { device: device ?? forPort ?? null, port, account, isPhone: isPhoneName(device) };
}

/**
 * Brings a phone to a state CDP can actually measure, and returns what it bound. A no-op for a
 * browser, so every atom can call it unconditionally.
 *
 * `ensure` is the ladder that already knows every way this goes wrong: wake, launch if the process
 * is gone, foreground it (a backgrounded WebView keeps its devtools socket listed and then answers
 * nothing), re-point the `adb forward` at the CURRENT pid - the socket name carries it, so a
 * relaunch or a reinstall invalidates the old one - and report success only once CDP has answered.
 * Every one of those steps has produced a wrong verdict on its own.
 *
 * The bound is 10 s rather than `ensure`'s 20 s default: ten seconds is long enough to show that a
 * launch worked, and a phone that needs longer is one worth being told about rather than waited for.
 *
 * @param label what to print in front of the lines, usually the atom's name and account
 */
export async function armIfPhone({ device, port, isPhone }, label) {
  if (!isPhone) return null;
  const bound = useDevice(device);
  console.log(`[${label}] device ${device} -> ${bound}`);
  const up = await ensure({ port, timeoutMs: 10_000 });
  if (!up.ok) throw new Error(`the phone is not measurable: ${up.reason}`);
  console.log(`[${label}] phone armed over ${up.how}, app pid ${up.pid}, CDP answering on ${port}`);
  return up;
}
