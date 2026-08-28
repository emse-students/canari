/**
 * The preflight's readiness probe, exercised on the four pages it has to tell apart.
 *
 * IT EXISTS BECAUSE THE PROBE IS A STRING, AND A STRING IS NOT COMPILED. `READY` in `run.mjs` is a
 * template literal evaluated inside the client, so every escape in it is processed TWICE - once by
 * this file's parser and once by the page's. On 2026-08-28 a `\/` that should have been `\/` left
 * the emitted probe reading `/^/login/`, which is a SyntaxError in the page: `node -c run.mjs` was
 * happy, the rig's own tests were happy, and every phase would have died on its first readiness
 * question with an error naming the wrong thing entirely. `oxlint` caught it. Nothing else could.
 *
 * It reads the template out of `run.mjs` rather than importing it, because `run.mjs` is a CLI that
 * runs a campaign on import. Scraping is the price of that, and asserting the match is found is what
 * stops this passing vacuously if the constant is ever renamed or moved.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const m = src.match(/^const READY = `([\s\S]*?)`;/m);
if (!m) {
  console.error("[ready] no `const READY = ` ... `` in run.mjs - the probe moved, and nothing here tested it");
  process.exit(1);
}

// The template interpolates `OVERLAYS`; any JSON array will do, since no case here opens a modal.
// `new Function` rather than `eval`, and not only for the lint: it processes the escapes exactly as
// the parser would while keeping this file's scope out of reach, so the string under test cannot
// accidentally read a variable the page would never have.
let probe;
try {
  probe = new Function("OVERLAYS", "return `" + m[1] + "`")(JSON.stringify("[]"));
} catch (e) {
  console.error(`[ready] the template itself does not evaluate: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/**
 * One page, as the probe sees it. `sidebar` is how many buttons the aside/nav rendered.
 *
 * `document` and `location` are ARGUMENTS, not globals: the probe reads them as free names, so
 * handing them in is both closer to what a page does and impossible to leak between cases.
 */
const evaluateProbe = new Function("document", "location", `return ${probe}`);
function ask({ pathname, sidebar = 0, gate = false, username = false }) {
  const doc = {
    querySelectorAll: () => ({ length: sidebar }),
    querySelector: (sel) =>
      sel === "#encryption-pin" ? (gate ? {} : null) : sel === "#username" ? (username ? {} : null) : null,
    body: { innerText: "" },
  };
  return JSON.parse(evaluateProbe(doc, { pathname }));
}

const cases = [
  ["a logged-out client on the launcher", { pathname: "/login" }, "signedOut"],
  ["the CAS form, whatever the path says", { pathname: "/chat", username: true }, "signedOut"],
  ["the PIN gate, which outranks everything", { pathname: "/login", gate: true }, "LOCKED"],
  ["a page the proof cannot judge", { pathname: "/posts", sidebar: 12 }, "unknown"],
  ["on /chat with nothing rendered yet", { pathname: "/chat" }, "booting"],
  ["on /chat, rendered", { pathname: "/chat", sidebar: 9 }, "unlocked"],
];

let bad = 0;
for (const [what, page, want] of cases) {
  const got = ask(page).locked;
  if (got === want) console.log(`  ok   ${what} -> ${got}`);
  else {
    console.error(`  FAIL ${what} -> ${got}, wanted ${want}`);
    bad++;
  }
}

if (bad) {
  console.error(`[ready] ${bad} of ${cases.length} cases wrong`);
  process.exit(1);
}
console.log(`[ready] clean - ${cases.length} pages classified as intended`);
