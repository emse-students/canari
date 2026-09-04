#!/usr/bin/env node
/**
 * DEAD CONVERSATION ROWS ON A DEVICE - list them, and dismiss the ones you name.
 *
 *   bun deadrows.mjs --port 9224 --match "^READ10-"            list only
 *   bun deadrows.mjs --port 9224 --match "^READ10-" --dismiss  and clear them
 *
 * WHAT A DEAD ROW IS. A conversation the peer deleted is not removed locally: it is marked
 * `removed` and kept until its owner dismisses it by hand - the first guard in
 * `decideAbsentGroupFate`, which no server state can reach past. That is right for a person and
 * wrong for a rig. The row survives every reconciliation, narrates itself on every load
 * (`[DISCOVERY] UI group "X" kept - already removed, awaiting a manual deletion`), and is per
 * DEVICE: a group whose members included an account holds one on every device that account has.
 * READ-10 created one per run and the phone had three of them before anyone counted.
 *
 * WHY IT IS A SHARED TOOL AND NOT A THROWAWAY. READ-10 cleans up after itself now, but every DEL
 * row is about to make the same kind of litter, and a rig-levelling step that exists once is a step
 * every phase can use. What it must never become is a "clear the sidebar" button.
 *
 * SO `--match` IS REQUIRED, AND IT IS AN ALLOWLIST. A destructive control needs a list of what it
 * MAY touch, never a list of what it may not: these profiles hold real conversations with real
 * people, and the two test accounts talk to a dozen of them. A pattern that would match everything
 * (`.`, `.*`, `^`) is refused outright rather than confirmed, and a row is only ever dismissed after
 * OPENING it and reading `removed` off the pane - the state, never the name.
 */
import { APP_TAB, client, ensureChat, evaluate, PANE_STATE, parkConversation, until } from '../chat.mjs';
import { dismissLocally, openGroup } from '../groupnav.mjs';
import { PORTS } from '../names.mjs';

const argv = process.argv.slice(2);
const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const port = Number(arg('--port') || PORTS.W1);
const pattern = arg('--match');
const dismiss = argv.includes('--dismiss');

if (!pattern) {
  console.error('deadrows: --match "<regexp>" is required - see the allowlist note in the header');
  process.exit(2);
}
if (/^\W*(\.|\.\*|\^|\$)\W*$/.test(pattern)) {
  console.error(`deadrows: --match ${JSON.stringify(pattern)} would match every conversation - refused`);
  process.exit(2);
}
const match = new RegExp(pattern);

const host = port === PORTS.A1 ? 'tauri.localhost' : APP_TAB;
const cx = await client(port, host);
// NOT `goto('/chat')`: on A1 that reloads the Tauri webview and re-locks the PIN, and `chat.mjs`
// refuses it outright. `ensureChat` alone is not enough either - it returns `'already'` the instant
// the path is `/chat`, and a phone sitting IN a conversation is on `/chat` with the list off screen.
// Both, in this order, is what "show me the conversation list" means on either device.
await ensureChat(cx);
await parkConversation(cx);
await until(cx, `!!document.querySelector('.sidebar-panel')`, 15000);

/** How many rows the sidebar is showing right now. */
const ROW_COUNT = `document.querySelectorAll('.sidebar-panel button, .sidebar-panel [role=button], .sidebar-panel a, .sidebar-panel li').length`;

/**
 * Waits until the row count STOPS CHANGING, because the panel existing is not the panel being full.
 *
 * The list is fetched, so a read taken the instant `.sidebar-panel` appears is a read of a partly
 * populated list - and for a tool whose whole output is "these rows are dead and these are not",
 * that is the worst possible failure: it reports a clean device by looking too early. Measured
 * 2026-08-21 on A1, twice: thirty tokens and no match, on a phone whose list held thirteen rows and
 * three dead ones.
 *
 * Two equal samples rather than a sleep. A fixed wait would be a guess about the network, and this
 * asks the only question that matters - has it settled - with the deadline as a bound rather than as
 * the answer.
 */
async function settledRowCount({ everyMs = 700, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const n = Number(await evaluate(cx, ROW_COUNT));
    if (n > 0 && n === previous) return n;
    previous = n;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return Number(await evaluate(cx, ROW_COUNT));
}
const rowCount = await settledRowCount();

/**
 * Every WHITESPACE-SEPARATED TOKEN in the sidebar's rows, which is where a name has to be looked for.
 *
 * THE FIRST LINE OF A ROW IS NOT THE NAME, and assuming it was found nothing on a phone holding
 * three dead rows. A row's `innerText` starts with the avatar's initials and continues into the
 * last-message preview - an avatar initial, then the name, then who said what - so
 * `^READ10-` matched no row at all while three were on screen.
 *
 * Tokens rather than lines, and that is a deliberate narrowing of what this tool can target: a
 * machine-generated name (`READ10-mt3bjpjl`, `HGRPktp5w`) has no spaces in it, and a person's
 * conversation does. So the tool can name the campaign's own litter and cannot name a real
 * conversation even by accident - which for something that dismisses things is the property worth
 * having. `openGroup` then matches by CONTAINS, so the token is enough to address the row.
 */
const tokens = JSON.parse(
  await evaluate(
    cx,
    `JSON.stringify((function () {
      var panel = document.querySelector('.sidebar-panel');
      if (!panel) return [];
      var out = [];
      var rows = panel.querySelectorAll('button, [role=button], a, li');
      for (var i = 0; i < rows.length; i++) {
        var t = (rows[i].innerText || '').trim();
        if (!t) continue;
        // NO REGEX HERE, and that is not a style choice: this string is a JS TEMPLATE LITERAL,
        // so a backslash in it is an ESCAPE - a whitespace class written the obvious way reaches
        // the page with its backslash eaten, and splits the text on the letter s. It did:
        // "...cette conver" / "ation". This comment carries no backslash for the same reason.
        // Newline then space, both as characters, is the same split with nothing to lose.
        var parts = t.split(String.fromCharCode(10)).join(' ').split(' ');
        for (var j = 0; j < parts.length; j++) {
          var w = parts[j].trim();
          if (w && out.indexOf(w) === -1) out.push(w);
        }
      }
      return out;
    })())`
  )
);

const candidates = tokens.filter((n) => match.test(n));
console.log(
  `[deadrows] port ${port}: ${rowCount} row(s) settled, ${tokens.length} token(s), ${candidates.length} match ${pattern}`
);

let removed = 0;
let live = 0;
for (const name of candidates) {
  try {
    // PARK BEFORE EVERY ROW, not once before the loop. Mobile gives the whole screen to the
    // conversation, so opening the first candidate hides the list the second one has to be found in -
    // and `openGroup` then times out against a sidebar that is not on screen. Two of three rows were
    // reported unopenable for exactly this, on a phone where all three were sitting in the list.
    await parkConversation(cx);
    await openGroup(cx, name, { navigate: false, label: 'deadrows' });
  } catch (e) {
    console.log(`  skip  ${name} - would not open: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const state = await evaluate(cx, PANE_STATE);
  if (state !== 'removed') {
    live++;
    console.log(`  LIVE  ${name} - pane is '${state}', left alone`);
    continue;
  }
  removed++;
  if (!dismiss) {
    console.log(`  dead  ${name} - would dismiss (pass --dismiss)`);
    continue;
  }
  await dismissLocally(cx, name);
  console.log(`  gone  ${name} - dismissed`);
}

console.log(`[deadrows] ${removed} dead, ${live} live and untouched${dismiss ? '' : ' - nothing was changed'}`);
cx.close();
