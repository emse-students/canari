#!/usr/bin/env bun
/**
 * Saves a PNG of a client, so a layout claim is LOOKED AT rather than inferred.
 *
 *   bun shot.mjs --device W1                  -> shot-W1.png
 *   bun shot.mjs --android --out gate.png     the phone's WHOLE SCREEN
 *   bun shot.mjs --android --webview          just the WebView, through CDP
 *   bun shot.mjs --port 9222                  an ad-hoc profile with no name
 *
 * It took `bun shot.mjs 9224 out.png` until 2026-09-04 - two positional arguments, in a rig where
 * every other atom takes `--device`. A caller then had to hold the port numbers in their head, which
 * is the same class of defect as making them type an account key: `PORTS` already maps a name to a
 * port, so the mapping is DATA. `device.mjs` resolves it here as everywhere else.
 *
 * **ON A PHONE THE DEFAULT IS `adb screencap`, AND THE DIFFERENCE IS NOT COSMETIC.** A CDP
 * screenshot renders the WEBVIEW and nothing else, so a native permission dialog, the IdP browser,
 * an Android toast, the keyboard, a system overlay and a crash dialog are all INVISIBLE to it - and
 * those are most of the reasons a phone run stalls with the product looking fine. The user's own
 * standing rule for this rig is to look at the screen when something does not work
 * (*"adb exec-out screencap -p > shot.png puis Read"*, 2026-09-04), and a WebView-only capture
 * cannot answer that question. `--webview` asks for the narrow one deliberately, when the question
 * really is about the page's own layout.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { client } from './chat.mjs';
import { armIfPhone, resolveDevice, tabMatchFor } from './device.mjs';
import { serial } from './serial.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const target = resolveDevice(argv);
const webviewOnly = argv.includes('--webview');
const label = `shot:${target.device ?? target.port}`;
const out = opt('out', `shot-${target.device ?? target.port}.png`);

/**
 * WHERE A BARE NAME LANDS, AND WHY IT IS NOT THE WORKING DIRECTORY.
 *
 * A plain `--out gate.png` is written NEXT TO THIS SCRIPT, because `tools/cross-client-harness`
 * gitignores `*.png` as "run artefacts written next to the runner" and the repository root does not.
 * Defaulting to the CWD would scatter screenshots into whatever directory the operator happened to
 * be in, and this repository is PUBLIC - a screenshot of a logged-in client carries a display name,
 * a conversation and a device, and the only reason none has ever been committed is that ignore rule.
 *
 * A path with a SEPARATOR or a drive is taken at its word and resolved against the CWD, which is
 * what every other command does. That half was missing: `new URL('./' + out, import.meta.url)` on
 * `--out /tmp/w1.png` produced a directory that does not exist and a stack trace, so the only usable
 * spelling was a bare filename and nothing said so.
 */
const looksLikeAPath = /[\\/]/.test(out) || /^[A-Za-z]:/.test(out);
const dest = looksLikeAPath ? resolve(out) : new URL(`./${out}`, import.meta.url);

if (target.isPhone && !webviewOnly) {
  // Bound first, so a two-phone bench captures the phone this run is about rather than whichever
  // one adb happens to list first - the same reason `logcatSince` resolves per call.
  await armIfPhone(target, label);
  // `exec-out`, never `shell`: `shell` runs through a pty that rewrites LF to CRLF and corrupts
  // every PNG it carries. The bytes are binary and must not be decoded on the way, which is why
  // this asks for a Buffer rather than a string.
  const png = execFileSync('adb', ['-s', serial(), 'exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(dest, png);
  console.log(`[${label}] wrote ${out} - the WHOLE screen (${png.length} bytes)`);
  process.exit(0);
}

await armIfPhone(target, label);
const cx = await client(target.port, tabMatchFor(target));
await cx.send('Page.enable');
const res = await cx.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(dest, Buffer.from(res.data, 'base64'));
console.log(
  `[${label}] wrote ${out}` +
    (target.isPhone ? ' - the WEBVIEW ONLY; a native dialog or overlay is not in this image' : ''),
);
process.exit(0);
