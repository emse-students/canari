/**
 * The `adb` half shared by every instrument here: one device, one package, one CDP forward.
 *
 * The serial is read from `ANDROID_SERIAL` or from the single attached device. IT IS NEVER
 * GUESSED when two are attached - the campaign runs against several handsets and a measurement
 * attributed to the wrong one is worse than no measurement.
 */
const PACKAGE = 'fr.emse.canari';
const ACTIVITY = `${PACKAGE}/.MainActivity`;

/** Runs one `adb` command and returns its stdout, trimmed. Throws on a non-zero exit. */
export async function adb(serial, args) {
  const argv = serial ? ['-s', serial, ...args] : args;
  const proc = Bun.spawn(['adb', ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`adb ${args.join(' ')} exited ${code}: ${err.trim()}`);
  return out.trim();
}

/** The one attached device, or `ANDROID_SERIAL`. */
export async function deviceSerial() {
  const named = process.env.ANDROID_SERIAL;
  if (named) return named;
  const lines = (await adb(null, ['devices']))
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0]);
  if (lines.length === 1) return lines[0];
  throw new Error(
    lines.length === 0
      ? 'no device attached'
      : `${lines.length} devices attached (${lines.join(', ')}) - set ANDROID_SERIAL`
  );
}

export const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

export const forceStop = (serial) => adb(serial, ['shell', 'am', 'force-stop', PACKAGE]);
export const launch = (serial) => adb(serial, ['shell', 'am', 'start', '-n', ACTIVITY]);

/** `logcat -d -v time`, split into lines. */
export async function logcatDump(serial) {
  return (await adb(serial, ['logcat', '-d', '-v', 'time'])).split('\n');
}

/**
 * Forwards `tcp:<port>` onto the app WebView's devtools socket, POLLING for that socket rather
 * than sleeping a guessed amount: attaching late loses exactly the console lines a cold start is
 * being measured for.
 */
export async function forwardDevtools(serial, port = 9222, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const unix = await adb(serial, ['shell', 'cat', '/proc/net/unix']).catch(() => '');
    const socket = [...new Set(unix.match(/webview_devtools_remote_\d+/g) ?? [])][0];
    if (socket) {
      await adb(serial, ['forward', '--remove', `tcp:${port}`]).catch(() => {});
      await adb(serial, ['forward', `tcp:${port}`, `localabstract:${socket}`]);
      return socket;
    }
  }
  throw new Error('the app WebView never opened a devtools socket');
}

/**
 * Whether the app's process is alive right now.
 *
 * `pidof` answers an empty string and exit 1 when nothing matches, which `adb()` turns into a
 * throw - so the absence is caught here rather than at every call site. Used to separate a launch
 * that DIED from one that merely never reached the prompt: the two produce the same missing
 * bracket and want opposite next steps.
 */
export async function isRunning(serial) {
  try {
    return (await adb(serial, ['shell', 'pidof', PACKAGE])).length > 0;
  } catch {
    return false;
  }
}
