#!/usr/bin/env bun
/**
 * What the BACK button has left to go back to - the one reading a screenshot cannot give.
 *
 *   bun navstack.mjs --android
 *   bun navstack.mjs --device W1
 *
 * WHY IT EXISTS. "Back exits the app" and "Back steps to the list" look identical in every artefact
 * this rig already produces: a screenshot shows the screen AFTER the press, and the logs name what
 * the app decided to do, not what the history holds. So a back-navigation defect could only be
 * reasoned about, and a reading of the code disagreed with the handset twice on 2026-09-21 - once
 * about whether the route push had happened at all, and once about whether a fix had changed
 * anything. A measurement settles in one call what two readings did not.
 *
 * WHAT EACH FIELD ANSWERS, because they fail in different directions:
 *
 *   - `pathname`  which page the router believes it is on. A landing that never arrived shows the
 *                 page it started from while the screen already shows the conversation.
 *   - `length`    how many entries the WebView will step through before `canGoBack()` is false and
 *                 Android finishes the activity. **1 means the very next Back press EXITS.**
 *   - `state`     the top entry's own state object. `{"canariOverlay":N}` means the top entry was
 *                 pushed by `historyOverlayStack`, so Back should CLOSE an overlay rather than
 *                 navigate; `null` is a plain router entry. This is what separates "the overlay
 *                 entry was never pushed" from "it was pushed and then drained", which is the
 *                 distinction the whole ghost-entry mechanism turns on.
 *
 * It reads three built-ins and writes nothing, so it is safe to run mid-check: it cannot move the
 * pointer, the history or the selection.
 */
import { client } from './chat.mjs';
import { evaluate } from './cdp.mjs';
import { armIfPhone, resolveDevice, tabMatchFor } from './device.mjs';

const argv = process.argv.slice(2);
const target = resolveDevice(argv);
const label = `navstack:${target.device ?? target.port}`;

/** Fixed expression, no interpolation - there is nothing here a caller may vary. */
const NAVSTACK = `(function () {
  var s = null;
  try { s = JSON.stringify(history.state); } catch (e) { s = '<unreadable>'; }
  return JSON.stringify({
    pathname: location.pathname,
    length: history.length,
    state: s,
  });
})()`;

await armIfPhone(target, label);
const cx = await client(target.port, tabMatchFor(target));
const raw = await evaluate(cx, NAVSTACK);
const nav = JSON.parse(raw);

console.log(`[${label}] pathname ${nav.pathname}`);
console.log(
  `[${label}] history.length ${nav.length}` +
    (nav.length <= 1 ? ' - THE NEXT BACK PRESS EXITS THE APP' : ''),
);
console.log(
  `[${label}] history.state ${nav.state}` +
    (nav.state && nav.state.includes('canariOverlay')
      ? ' - the top entry is an overlay, so Back should close it'
      : ' - a plain router entry, so Back navigates'),
);
process.exit(0);
