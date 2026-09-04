#!/usr/bin/env bun
/**
 * Waits for one message to ARRIVE on one client, and ends on the bubble rather than on a clock.
 *
 * IT WRAPS `awaitMessage()` FROM `chat.mjs`, which already carries the hard part: when the marker
 * does not appear it reports the PANE STATE with the miss, because "never appeared" cannot tell
 * apart a message that is absent, one that is late, and one that is merely below the render window -
 * `ChatArea` keeps a sliding window, and a pane scrolled up genuinely does not render what arrives
 * under it. Two of those are defects and the third is a precondition the caller owes.
 *
 * THIS IS THE OTHER HALF OF `send.mjs` AND THE SPLIT IS THE POINT. A sender proves it composed; only
 * a RECEIVER can prove delivery, and only from its own device. One command doing both would be one
 * command that cannot fail honestly.
 *
 * Usage:
 *   bun recv.mjs --device W2 --expect "<marker or text>"
 *   bun recv.mjs --android --expect abc123 --in "<conversation>" --timeout 30000
 *
 *   --expect   the substring to wait for - a marker printed by `send.mjs` is the intended input
 *   --in       open this conversation first; omitted, whatever is already open is watched
 *   --timeout  milliseconds, default 20000
 *   --absent   INVERT: end when the marker is still absent after the timeout, and FAIL if it appears
 */
import { awaitMessage, client, ensureChat, openConversation, paneState, APP_TAB } from './chat.mjs';
import { armIfPhone, resolveDevice } from './device.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const target = resolveDevice(argv);
const expect = opt('expect', null);
if (!expect) throw new Error('--expect is required - waiting for nothing in particular is not a fact');
const inConversation = opt('in', null);
const timeoutMs = Number(opt('timeout', 20_000));
const absent = argv.includes('--absent');
const label = `recv:${target.device ?? target.port}`;

await armIfPhone(target, label);

const cx = await client(target.port, APP_TAB);
await ensureChat(cx);
if (inConversation) {
  console.log(`[${label}] opening ${JSON.stringify(inConversation)}`);
  await openConversation(cx, inConversation);
}

if (absent) {
  // AN ABSENCE IS ONLY EVIDENCE WITH A DEADLINE ON IT, and it is the one case where spending the
  // whole budget is the correct outcome rather than a failure. It is a separate flag rather than a
  // second script because it is the SAME question with the answer inverted, and two scripts would
  // drift on what "arrived" means.
  const t0 = Date.now();
  try {
    await awaitMessage(cx, expect, timeoutMs);
  } catch {
    console.log(`[${label}] still absent after ${timeoutMs}ms, as expected: ${JSON.stringify(expect)}`);
    console.log(`[${label}] pane: ${JSON.stringify(await paneState(cx, expect))}`);
    cx.close();
    process.exit(0);
  }
  console.error(`[${label}] ARRIVED, and this run asserted it would not: ${JSON.stringify(expect)}`);
  cx.close();
  process.exit(1);
}

const t0 = Date.now();
await awaitMessage(cx, expect, timeoutMs);
console.log(`[${label}] arrived after ${Date.now() - t0}ms: ${JSON.stringify(expect)}`);
cx.close();
