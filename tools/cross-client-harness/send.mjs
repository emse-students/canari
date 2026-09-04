#!/usr/bin/env bun
/**
 * Sends one message from one client, and ends when that client's own pane shows it.
 *
 * IT WRAPS `send()` FROM `chat.mjs` AND ADDS NOTHING TO IT. The gesture - arm the composer, fire it -
 * already existed and is used by a dozen archived rows; what did not exist was a way to TYPE it. The
 * whole file is argument resolution and a post-condition, which is what an atom's CLI half should be.
 *
 * THE POST-CONDITION IS THE SENDER'S OWN PANE, deliberately, and it is not delivery. A message
 * appearing where it was typed proves the composer fired and the client accepted it; whether the
 * PEER received it is a different question with a different answer, and `recv.mjs` is where it is
 * asked. Conflating the two is how a row reports "sent" for a message nobody got - and it is why
 * `--expect-peer` does not exist here.
 *
 * Usage:
 *   bun send.mjs --device W1 --to "<conversation>" --text "hello"
 *   bun send.mjs --android --to "<conversation>" --text "hello"
 *   bun send.mjs --device W1 --to "<conversation>" --text "hello" --marker M-42
 *
 *   --to      the conversation as the sidebar names it; omitted, whatever is already open is used
 *   --marker  a token to send INSTEAD of composing one, when the caller wants to grep for it later
 */
import {
  APP_TAB,
  awaitMessage,
  awaitRequest,
  client,
  ensureChat,
  openConversation,
  requestsSince,
  send,
} from './chat.mjs';
import { armIfPhone, resolveDevice } from './device.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const target = resolveDevice(argv);
const to = opt('to', null);
const text = opt('text', null);
if (!text) throw new Error('--text is required - a send with nothing to send is not a gesture');

// THE MARKER IS WHAT MAKES A MESSAGE FINDABLE LATER, and a run that sends the same words twice
// cannot tell its two messages apart. The default carries the clock so two runs never collide;
// `--marker` exists for a caller that already has an id it wants to grep for.
const marker = opt('marker', `s${Date.now().toString(36)}`);
const body = `${text} [${marker}]`;
const label = `send:${target.device ?? target.port}`;

await armIfPhone(target, label);

const cx = await client(target.port, APP_TAB);
await ensureChat(cx);
if (to) {
  console.log(`[${label}] opening ${JSON.stringify(to)}`);
  await openConversation(cx, to);
} else {
  console.log(`[${label}] no --to, sending into whatever is already open`);
}

// THE NETWORK IS WATCHED FROM BEFORE THE GESTURE, because the answer arrives during it.
await cx.send('Network.enable');
const sinceIndex = cx.events.length;

await send(cx, body);

// A BUBBLE IN THE SENDER'S OWN PANE IS NOT A SENT MESSAGE, and the first version of this file said
// it was. The app renders optimistically: on 2026-09-04 this reported `sent and visible here` for a
// message the server had REFUSED three times with 403 `SenderNotActiveError` - the device holds no
// leaf in the group - and `queued_message` had no row for it. A post-condition that cannot fail
// where the product does is decoration.
//
// So the pane is checked FIRST (it proves the composer fired and is a better failure message when it
// did not), and then the WIRE is checked, which is the half that can be refused.
await awaitMessage(cx, marker, 20_000);

const sendId = await awaitRequest(cx, /\/api\/mls\/send/, sinceIndex, 15_000);
if (!sendId) {
  const seen = requestsSince(cx, /\/api\//, sinceIndex).slice(-8);
  console.error(`[${label}] the bubble rendered but NO POST /api/mls/send was made in 15s`);
  console.error(`[${label}] api calls seen: ${seen.join(' ') || '(none)'}`);
  cx.close();
  process.exit(1);
}

// THE STATUS, AND IT IS WAITED FOR. `awaitRequest` returns when the request is SENT, so reading the
// response in the same tick finds nothing and `status ?? 'pending'` then reported success for a send
// the server was about to refuse - measured 2026-09-04, one layer below the defect this check was
// added to catch. A pending answer is not a good answer.
const responseStatus = async (requestId, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = cx.events.find(
      (e) => e.method === 'Network.responseReceived' && e.params?.requestId === requestId,
    );
    if (ev) return ev.params.response.status;
    const failed = cx.events.find(
      (e) => e.method === 'Network.loadingFailed' && e.params?.requestId === requestId,
    );
    if (failed) return `failed: ${failed.params.errorText}`;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};

const status = await responseStatus(sendId);

if (status === null) {
  console.error(`[${label}] POST /api/mls/send never answered within 15s - the message did not ship`);
  cx.close();
  process.exit(1);
}
if (typeof status === 'string') {
  console.error(`[${label}] POST /api/mls/send ${status}`);
  cx.close();
  process.exit(1);
}

if (status >= 400) {
  const refusal = cx.events
    .slice(sinceIndex)
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .flatMap((e) => (e.params.args || []).map((a) => String(a.value ?? '')))
    .find((t) => t.includes('REFUSED by the server'));
  console.error(`[${label}] the server REFUSED the send with ${status}`);
  if (refusal) console.error(`[${label}] ${refusal.replace(/\s+/g, ' ').slice(0, 300)}`);
  cx.close();
  process.exit(1);
}

console.log(`[${label}] sent, rendered here, and the server took it (${status})`);
console.log(`[${label}] ${JSON.stringify(body)}`);
console.log(`[${label}] marker ${marker}`);
cx.close();
