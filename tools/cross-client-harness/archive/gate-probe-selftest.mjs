/**
 * `pin.mjs`'s gate probe, exercised on the pages it has to tell apart.
 *
 * SAME REASON AS `ready-selftest.mjs`: the probe is a template literal evaluated inside the client,
 * so every escape in it is processed twice, and `node -c` sees neither pass. The keypad test carries
 * a `⌫` escape, which is exactly the shape that shipped broken once already.
 *
 * AND THE CLASSIFICATION ITSELF IS WORTH PINNING, because it decides between two opposite repairs.
 * On 2026-08-28 `pin.mjs` read the DOM once, found no modal on a client still routing to `/chat`,
 * and reported "no unlock modal on screen" - which `newdevice.mjs` recorded as `pinGate: none shown`
 * and turned into a `FAIL` on HEAL-NEW-0, the primitive eleven rows rest on. A client that is PAST
 * the gate and a client that has not reached it yet look identical to a single read; only the
 * sidebar proof separates them.
 *
 * The template is scraped rather than imported because `pin.mjs` is a CLI that types a PIN on
 * import. Asserting the match is found is what stops this passing vacuously if the constant moves.
 */
import { readFileSync } from "node:fs";
import { GATE_EXPR } from "../gate-probe.mjs";

const src = readFileSync(new URL("../pin.mjs", import.meta.url), "utf8");
const m = src.match(/^const GATE_PROBE = `([\s\S]*?)`;/m);
if (!m) {
  console.error("[gate] no `const GATE_PROBE = ` ... `` in pin.mjs - the probe moved, and nothing here tested it");
  process.exit(1);
}

let probe;
try {
  probe = new Function("GATE_EXPR", "return `" + m[1] + "`")(GATE_EXPR);
} catch (e) {
  console.error(`[gate] the template itself does not evaluate: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const evaluateProbe = new Function("document", "location", `return ${probe}`);

/**
 * One page, as the probe sees it.
 *
 * `document` and `location` are ARGUMENTS, so the string under test cannot read anything a page
 * would not have. The keypad is modelled as a real button whose label is the erase glyph, because
 * that glyph IS the escape this file exists to check.
 */
function ask({ pathname, sidebar = 0, field = false, keypad = false, text = "", dialogs = [] }) {
  const buttons = keypad ? [{ innerText: " ⌫ " }] : [];
  const modals = dialogs.map((label) => ({ getAttribute: (a) => (a === "aria-label" ? label : null) }));
  const doc = {
    querySelector: (sel) => (sel === "#encryption-pin" ? (field ? {} : null) : null),
    querySelectorAll: (sel) => {
      if (sel === "button") return buttons;
      if (sel === "[role=dialog]") return modals;
      return { length: sidebar };
    },
    body: { innerText: text },
  };
  return JSON.parse(evaluateProbe(doc, { pathname }));
}

const cases = [
  ["the desktop text field", { pathname: "/chat", field: true }, { gate: true }],
  ["the mobile keypad, by its erase glyph", { pathname: "/chat", keypad: true }, { gate: true, keypad: true }],
  ["the gate as its own dialog, by label", { pathname: "/chat", dialogs: ["PIN de chiffrement"] }, { gate: true }],
  ["the first-setup variant, whose label contains the other", { pathname: "/chat", dialogs: ["Choisir un PIN de chiffrement"] }, { gate: true }],

  // THE FOUR THAT COST ROWS. Each of these pages was read as LOCKED by the old body-text
  // condition, and a client that cannot be brought past the gate produces no verdict at all.
  ["/settings, whose security section NAMES the PIN", { pathname: "/settings", sidebar: 9, text: "Code PIN de chiffrement" }, { gate: false }],
  ["the gate named only in prose is not the gate", { pathname: "/chat", text: "PIN de chiffrement" }, { gate: false }],
  ["the device panel, open over anything", { pathname: "/settings", dialogs: ["Gestion des appareils"] }, { gate: false }],
  ["a fresh phone's biometric offer, which is not a gate", { pathname: "/posts", sidebar: 10, dialogs: ["Connexion rapide"] }, { gate: false }],

  ["a client still routing, gate not mounted", { pathname: "/" }, { gate: false, onChat: false }],
  ["on /chat, nothing rendered yet - NOT past the gate", { pathname: "/chat" }, { gate: false, onChat: true, sidebar: 0 }],
  ["on /chat, rendered - past the gate, nothing to answer", { pathname: "/chat", sidebar: 9 }, { gate: false, onChat: true, sidebar: 9 }],
];

let bad = 0;
for (const [what, page, want] of cases) {
  const got = ask(page);
  const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
  if (wrong.length === 0) console.log(`  ok   ${what}`);
  else {
    console.error(`  FAIL ${what} -> ${wrong.map((k) => `${k}=${got[k]} wanted ${want[k]}`).join(", ")}`);
    bad++;
  }
}

if (bad) {
  console.error(`[gate] ${bad} of ${cases.length} cases wrong`);
  process.exit(1);
}
console.log(`[gate] clean - ${cases.length} pages classified as intended`);
