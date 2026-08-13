/**
 * Points `tcp:<port>` at the Canari WebView's devtools socket on the phone.
 *
 * THE SOCKET NAME CARRIES THE PID, so it changes on every restart and on every reinstall:
 * `@webview_devtools_remote_<pid>`. A forward set up in an earlier session survives in `adb forward
 * --list` and looks healthy while addressing nothing - or worse, addressing whatever else is
 * listening. Seen 2026-08-11: the forward pointed at `@chrome_devtools_remote` (Chrome's own),
 * `/json/list` answered with an empty array, and the phone read as "app not debuggable" while the
 * app was in the foreground.
 *
 * So the forward is derived from the RUNNING pid every time, never remembered.
 *
 *   import { forwardA1 } from './a1forward.mjs';
 *   await forwardA1(9333);
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();

export async function forwardA1(port = 9333, pkg = 'fr.emse.canari') {
  const pid = adb('shell', 'pidof', pkg).split(/\s+/)[0];
  if (!pid) throw new Error(`${pkg} is not running - launch it before forwarding`);
  const socket = `webview_devtools_remote_${pid}`;
  try {
    adb('forward', '--remove', `tcp:${port}`);
  } catch {
    // No forward to remove; that is the normal first-run case.
  }
  adb('forward', `tcp:${port}`, `localabstract:${socket}`);

  // A forward that resolves to no target is the failure this exists to prevent, so it is checked
  // here rather than left for the caller to discover as "no target matching tauri.localhost".
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  if (!targets.length) throw new Error(`forwarded to ${socket} but it exposes no target`);
  return { pid, socket, targets: targets.map((t) => t.url) };
}

// Run directly => do the forward and print it. `pathToFileURL` rather than a hand-built `file://`:
// on Windows the hand-built form is `file://C:/...` where `import.meta.url` is `file:///C:/...`, so
// the guard never matched, the script printed nothing, and it looked like it had run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await forwardA1(Number(process.argv[2] || 9333)), null, 1));
}
