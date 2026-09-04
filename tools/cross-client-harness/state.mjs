#!/usr/bin/env node
/**
 * One-line health read of every web client - the thing to run when a check behaves oddly.
 *
 * It answers, per client, the four questions that decide whether a measurement is worth anything:
 * is it on the right route, is the PIN gate up, has the chat actually mounted, and is the sidebar
 * populated. A check that starts against a client failing any of these does not fail - it HANGS, or
 * worse, reports on whatever was left on screen.
 *
 *   bun state.mjs
 */
import { client, evaluate } from './chat.mjs';
import { GATE_EXPR } from './gate-probe.mjs';
import { PORTS } from './names.mjs';

/**
 * THE LOCK ANSWER HAS THREE VALUES, NOT TWO, and that is the whole point of this field.
 *
 * The PIN gate only mounts where the encryption state is needed - on `/posts` or `/communities` a
 * fully LOCKED client shows no gate at all. Read as a boolean, that route reports "unlocked" about a
 * client that cannot decrypt or ACK a single frame, and every measurement taken after it is
 * worthless. It cost a drain investigation: A1 read `unlocked` on `/posts`, and `pin.mjs` then found
 * the keypad and typed four digits into it.
 *
 * `unknown` is therefore a real answer and the honest one: not "no", but "this route cannot say".
 * The only cure is to run `pin.mjs` after ANY restart, kill, reboot, radio cycle or `install -r` -
 * it is idempotent, so running it when it was not needed costs nothing.
 *
 * AND `signedOut` IS A FOURTH VALUE, ADDED AFTER THIS READER MISLABELLED THE ONE STATE THAT WAS
 * BLOCKING A RUNG. On 2026-08-28 W1 sat on `/login` for hours and this probe answered
 * `unknown (gate not on this route)` - true of the gate, and useless: `unknown` says "ask
 * elsewhere", while what was needed is "there is no session, run login.mjs". The distinction is
 * FREE, because the path is already in hand; `ready-probe.mjs` makes exactly the same call, and for
 * the same reason it comes FIRST - a PIN gate genuinely mounted over `/login` is a session problem,
 * and reading it as `LOCKED` sends the repair that cannot work.
 */
const PROBE = `JSON.stringify({
  path: location.pathname,
  ready: document.readyState,
  locked: (function () {
    if (/^\\/login/.test(location.pathname) || !!document.querySelector('#username')) return 'signedOut';
    var gate = ${GATE_EXPR};
    if (gate) return 'LOCKED';
    return /^\\/(chat|communities)/.test(location.pathname) ? 'unlocked' : 'unknown (gate not on this route)';
  })(),
  composer: !!document.querySelector('.chat-composer-footer .chat-composer-editor'),
  typingHook: !!document.querySelector('.chat-typing-indicator'),
  statusHook: document.querySelectorAll('.msg-status').length,
  sidebarButtons: document.querySelectorAll('aside button, nav button').length,
  bundle: (Object.keys(window).filter(function (k) {
    return k.indexOf('__sveltekit_') === 0 && k !== '__sveltekit_sw';
  })[0] || 'none')
})`;

for (const [label, port] of Object.entries(PORTS)) {
  try {
    const cx = await client(port, null, { focus: false });
    console.log(`${label} (${port}) ${await evaluate(cx, PROBE)}`);
    cx.close();
  } catch (e) {
    console.log(`${label} (${port}) UNREACHABLE: ${e.message}`);
  }
}
// NO `process.exit()` HERE. Closing a WebSocket and tearing the process down in the same tick trips
// a libuv assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and the
// script exits 9 - after printing a perfectly good answer. Anything reading the exit code then
// calls a healthy client broken. Closing every socket is enough to let the loop drain on its own.
