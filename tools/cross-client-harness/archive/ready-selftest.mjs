/**
 * The preflight's readiness probe, exercised on the pages it has to tell apart.
 *
 * IT EXISTS BECAUSE THE PROBE IS A STRING, AND A STRING IS NOT COMPILED. `READY_EXPR` is evaluated
 * inside the client, so nothing in this repo type-checks it. On 2026-08-28 a `\/` that should have
 * been `\/` left the emitted probe reading `/^/login/`, which is a SyntaxError in the page: `node -c`
 * was happy, the rig's own tests were happy, and every phase would have died on its first readiness
 * question with an error naming the wrong thing entirely. `oxlint` caught it. Nothing else could.
 *
 * IT USED TO SCRAPE `run.mjs` WITH A REGEX, because that file is a CLI that runs a campaign on
 * import. It now IMPORTS, because the probe moved to `ready-probe.mjs` - and the move is what the
 * `/settings` case below is about: the probe carried a FOURTH copy of the gate test keyed on
 * `document.body.innerText` containing "PIN de chiffrement", the exact string `/settings` prints in
 * its own security section. Every phase's preflight read a client parked there as LOCKED. That case
 * FAILS against the old body and passes against `GATE_EXPR`, which is the only reason to keep it.
 *
 * THE WHOLE PROBE IS UNDER TEST, NOT ITS `locked` BRANCH. The overlay field interpolates `OVERLAYS`
 * from `chat.mjs`, which reads geometry and computed style, so the fake below answers those too -
 * a smaller fake would leave the half that has actually broken twice unexercised.
 */
import { READY_EXPR } from "./ready-probe.mjs";

/**
 * One page, as the probe sees it.
 *
 * `document`, `location`, `window` and `getComputedStyle` are ARGUMENTS, not globals: the probe reads
 * them as free names, so handing them in is both closer to what a page does and impossible to leak
 * between cases.
 */
const evaluateProbe = new Function("document", "location", "window", "getComputedStyle", `return ${READY_EXPR}`);

/** A DOM node as the probe touches one: a box, no animations, and whatever attributes a case gave it. */
function node({ label, text = "", w = 0, h = 0 } = {}) {
  return {
    innerText: text,
    getAttribute: (a) => (a === "aria-label" ? (label ?? null) : null),
    getAnimations: () => [],
    getBoundingClientRect: () => ({ width: w, height: h }),
  };
}

function ask({ pathname, sidebar = 0, pinField = false, username = false, keypad = false, dialog = null, bodyText = "" }) {
  const buttons = keypad ? [node({ text: "⌫" })] : [];
  const dialogs = dialog === null ? [] : [node({ label: dialog })];
  const doc = {
    // The probe asks for four selector sets and nothing else; anything unlisted answering `[]` is
    // what a real page does too, and a typo in a selector then shows up as a wrong verdict here.
    querySelectorAll: (sel) => {
      if (sel === "aside button, nav button") return { length: sidebar };
      if (sel === "button") return buttons;
      if (sel === "[role=dialog]") return dialogs;
      if (sel === "[role=dialog][aria-modal=true]") return [];
      return [];
    },
    querySelector: (sel) =>
      sel === "#encryption-pin" ? (pinField ? node() : null) : sel === "#username" ? (username ? node() : null) : null,
    // KEPT THOUGH THE PROBE NO LONGER READS IT, and that is the assertion: the `/settings` case sets
    // it to the phrase the fourth copy matched on.
    body: { innerText: bodyText },
    readyState: "complete",
  };
  const win = { innerWidth: 1280, innerHeight: 800 };
  const style = () => ({ visibility: "visible", display: "block", opacity: "1" });
  return JSON.parse(evaluateProbe(doc, { pathname }, win, style));
}

const PIN_TEXT = "Code PIN de chiffrement";

const cases = [
  ["a logged-out client on the launcher", { pathname: "/login" }, "signedOut"],
  ["the CAS form, whatever the path says", { pathname: "/chat", username: true }, "signedOut"],
  // MEASURED ON W1, 2026-08-28: the PIN dialog really was mounted over the login page, and answering
  // LOCKED there sent pin.mjs to type a correct PIN into a client whose refresh cookie was already
  // proven dead - five passes, no progress, the rung unable to start. The path outranks the gate.
  [
    "a gate mounted over the LOGIN page is a session problem, not a gate problem",
    { pathname: "/login", pinField: true },
    "signedOut",
  ],
  ["the desktop gate where it can be answered", { pathname: "/chat", sidebar: 9, pinField: true }, "LOCKED"],
  ["the mobile keypad, which has no #encryption-pin", { pathname: "/chat", sidebar: 9, keypad: true }, "LOCKED"],
  ["the gate found by its dialog label", { pathname: "/chat", sidebar: 9, dialog: "PIN de chiffrement" }, "LOCKED"],
  [
    "THE FOURTH COPY'S FALSE POSITIVE: /settings NAMES the PIN and is not gated",
    { pathname: "/settings", sidebar: 12, bodyText: PIN_TEXT },
    "unknown",
  ],
  [
    "a dialog that is not the gate leaves the page judged on its path",
    { pathname: "/chat", sidebar: 9, dialog: "Ajouter un canal" },
    "unlocked",
  ],
  ["a page the proof cannot judge", { pathname: "/posts", sidebar: 12 }, "unknown"],
  ["on /chat with nothing rendered yet", { pathname: "/chat" }, "booting"],
  ["on /chat, rendered", { pathname: "/chat", sidebar: 9 }, "unlocked"],
];

let bad = 0;
for (const [what, page, want] of cases) {
  let got;
  try {
    got = ask(page).locked;
  } catch (e) {
    got = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (got === want) console.log(`  ok   ${what} -> ${got}`);
  else {
    console.error(`  FAIL ${what} -> ${got}, wanted ${want}`);
    bad++;
  }
}

// THE OVERLAY FIELD IS PART OF READY, and `isReady` is the AND of both - so a probe that classified
// every page above and returned a broken `overlay` would still refuse every device in the rig.
const clear = ask({ pathname: "/chat", sidebar: 9 });
if (clear.overlay !== 0) {
  console.error(`  FAIL an idle page reports ${clear.overlay} overlay(s), wanted 0`);
  bad++;
} else console.log("  ok   an idle page reports no overlay");

if (bad) {
  console.error(`[ready] ${bad} case(s) wrong`);
  process.exit(1);
}
console.log(`[ready] clean - ${cases.length} pages classified as intended, overlay read`);
