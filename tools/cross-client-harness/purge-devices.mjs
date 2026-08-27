/**
 * Deletes NAMED devices of an account, through the real UI.
 *
 * This is not a database purge wearing a UI costume. `purgeDeviceFootprint` is what deletes the
 * `queued_message` and `dm_device_group_memberships` rows, and it only runs on
 * `DELETE /api/mls/devices/:userId/:deviceId` - so driving the panel is the only way to find out
 * whether the product's own path really cleans up, which is the question being asked.
 *
 *   node purge-devices.mjs --only <deviceId>[,<deviceId>...] [--expect N] [--port 9224] [--dry]
 *
 * WHY IT WAS IMPOUNDED, AND WHAT CHANGED. Until 2026-08-27 this took `--keep`, a substring of the row
 * text that had to SURVIVE - a denylist, and one keyed on `/Appareil\s*\d/`, a string the product does
 * not render. Every row therefore read as the empty string, `--keep` matched nothing, and the tool
 * fell through to clicking the first deletable button in DOM order. Nothing in it made that button the
 * right one: one reorder and it deleted A1, costing a re-enrolment plus SETUP-4's 2FA. It was never
 * run, and this is the rewrite of what it is ALLOWED TO TOUCH that unimpounds it.
 *
 * **AN ALLOWLIST, NEVER A DENYLIST.** Nothing is deleted unless `--only` named it. With no `--only`
 * the tool reads the panel, prints it and deletes NOTHING - a destructive control with no allowlist
 * has nothing it may touch, which is the honest reading of an absent flag rather than an error to
 * work around.
 *
 * **THE KEY IS THE FULL DEVICE ID, AND IT IS THE ONE THE DELETE ITSELF USES.** The visible short id
 * is `deviceId.slice(0, 8)` and does NOT discriminate - every web device of one user renders the same
 * eight characters, which is why the backlog entry proposed keying on `Connecte le <date>` instead. It
 * does not have to: `DeviceManagementPanel.svelte` puts the WHOLE id in the `title` attribute of the
 * row's mono line, so the identity the API deletes by is in the DOM, per row, exactly once. An
 * attribute is as rendered as a text node for this purpose, and unlike a date it cannot tie.
 *
 * **`--expect N` REFUSES A FLEET THAT CHANGED SHAPE.** A caller decided what to delete by looking at a
 * panel; if the panel no longer holds that many deletable rows, something enrolled or vanished in
 * between and the decision was taken against a different fleet. That is a reason to stop, not to
 * proceed - the ordinal position that used to be load-bearing here is what made it dangerous.
 *
 * The current device has no delete button at all (`{#if !isCurrentDevice}`) and the panel refuses to
 * remove the last one, so the account always keeps at least one: the browser running this.
 */
import { client } from "./chat.mjs";
import { evaluate, realClick, until } from "./cdp.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const port = Number(opt("port", "9224"));
const dry = argv.includes("--dry");

/**
 * THE ALLOWLIST. Comma-separated device ids; a row is eligible only if its full id EQUALS one of them
 * or begins with it. A prefix is allowed because the panel is the only place these ids are ever read
 * from by a human, and refused below a length that could sweep a whole family: `web-` would match
 * every browser device on the account, which is precisely the accident this flag exists to prevent.
 */
const MIN_PREFIX = 8;
const only = (opt("only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const tooShort = only.filter((s) => s.length < MIN_PREFIX);
if (tooShort.length) {
  throw new Error(
    `--only entries must be at least ${MIN_PREFIX} characters to be an identity rather than a family: ${tooShort.join(" ")}`,
  );
}
const expect = opt("expect", null) === null ? null : Number(opt("expect"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) => console.log(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);

const DELETE_LABEL = "Supprimer l'appareil";
const DELETE_SEL = `[aria-label="${DELETE_LABEL}"]`;
// The label carries an apostrophe, so it can never be pasted into a single-quoted JS string sent
// over CDP - the quote closes the literal and the page throws a SyntaxError. Serialise it.
const DELETE_SEL_JS = JSON.stringify(DELETE_SEL);

/**
 * Walks up from a delete button to its ROW - the first ancestor holding exactly one `div[title]`,
 * which is the mono line carrying the full device id.
 *
 * Per-ROW is the whole point. `dlg.querySelectorAll('[title]')` would collect the rename buttons and
 * the header too, and pairing those with delete buttons by position is exactly the ordinal reasoning
 * this rewrite exists to remove.
 */
const ROW_WALKER = `function (b) {
  var el = b;
  for (var i = 0; i < 8 && el; i++) {
    var titled = el.querySelectorAll ? el.querySelectorAll('div[title]') : [];
    if (titled.length === 1 && (titled[0].getAttribute('title') || '').length > 0) return el;
    el = el.parentElement;
  }
  return null;
}`;

/** The panel's rows as DATA: each deletable row with the full device id it belongs to. */
const READ_PANEL = `(function () {
  var dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return { open: false, deletable: 0, rows: [] };
  var rowOf = ${ROW_WALKER};
  var buttons = Array.prototype.slice.call(dlg.querySelectorAll(${DELETE_SEL_JS}));
  var rows = buttons.map(function (b) {
    var row = rowOf(b);
    if (!row) return { deviceId: null, text: '(no id found for this row)' };
    return {
      deviceId: (row.querySelector('div[title]').getAttribute('title') || '').trim(),
      text: (row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
    };
  });
  return {
    open: true,
    deletable: buttons.length,
    rows: rows,
    text: (dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)
  };
})()`;

/** Tags the delete button of the row whose full device id is exactly `id`, or returns null. */
const TAG_BY_ID = (id) => `(function () {
  var dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  var want = ${JSON.stringify(id)};
  var rowOf = ${ROW_WALKER};
  var prev = dlg.querySelector('[data-purge-target]');
  if (prev) prev.removeAttribute('data-purge-target');
  var buttons = Array.prototype.slice.call(dlg.querySelectorAll(${DELETE_SEL_JS}));
  for (var i = 0; i < buttons.length; i++) {
    var row = rowOf(buttons[i]);
    if (!row) continue;
    if ((row.querySelector('div[title]').getAttribute('title') || '').trim() !== want) continue;
    buttons[i].setAttribute('data-purge-target', '1');
    return (row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  }
  return null;
})()`;

const cx = await client(port, "canari-emse.fr");
stage(`attached on ${port}`);

// Straight to /settings. A pushState would leave the router's data untouched on this route.
await evaluate(cx, `location.href = '/settings'`);
await sleep(6_000);
await until(cx, `location.pathname === '/settings'`, 30_000);
stage(`on ${await evaluate(cx, "location.pathname")}`);

// The card is behind `session.isLoggedIn`, i.e. behind the PIN. If the panel never opens, that is the
// reason - and it must be reported, not worked around.
const locked = await evaluate(
  cx,
  `document.body.innerText.includes('Deverrouillez la messagerie') || document.body.innerText.includes('D\\u00e9verrouillez la messagerie')`,
);
stage(`security card locked: ${locked}`);

await realClick(cx, "text=Gérer");
await until(cx, `!!document.querySelector('[role="dialog"]')`, 20_000);
// The panel opens EMPTY and fills in - it renders "Synchronisation des appareils..." while the list
// loads. Reading it before that settles returns zero rows, which is indistinguishable from an account
// with no other device: the first W2 run reported "0 deletable" for an account holding five.
//
// The string it waits for is `chat_devices_count_label`, "{devices} appareil(s) enregistre(s)". This
// predicate used to read /APPAREIL(S) CONNECT/i, which the product has never rendered, so the wait
// timed out after 45 s on a panel loaded the whole time. Matched on `enregistr` to clear the accent.
//
// THE LOAD ERROR IS A THIRD OUTCOME, AND IT IS REPORTED RATHER THAN WAITED ON.
// `chat_devices_load_error` ("Impossible de charger les appareils lies a votre compte.") satisfied no
// branch of this predicate, so a panel that had FAILED to load spent the full 45 s and then reported a
// timeout - which reads as "the panel never settled" when what happened is that the fleet could not be
// read AT ALL. A question that could not be asked is not the answer "no": it is accepted as settled
// here and classified immediately after, because nothing may be deleted from a fleet nothing has seen.
await until(
  cx,
  `(function () {
     var d = document.querySelector('[role="dialog"]');
     if (!d) return false;
     var t = d.innerText || '';
     if (t.includes('Impossible de charger les appareils')) return true;
     return !t.includes('Synchronisation des appareils') &&
            (/appareil\\(s\\)\\s*enregistr/i.test(t) || t.includes('Aucun appareil'));
   })()`,
  45_000,
);
const loadFailed = await evaluate(
  cx,
  `((document.querySelector('[role="dialog"]') || {}).innerText || '').includes('Impossible de charger les appareils')`,
);
if (loadFailed) {
  console.log(
    JSON.stringify(
      { port, only, expect, deleted: 0, refused: "devices-could-not-be-read" },
      null,
      2,
    ),
  );
  throw new Error(
    "the panel could not load the fleet - nothing is known about it, so nothing may be deleted",
  );
}
await sleep(1_500);
let panel = await evaluate(cx, READ_PANEL);
stage(`panel open: ${panel.deletable} deletable row(s)`);
for (const r of panel.rows) stage(`  row ${r.deviceId || "(no id)"} - ${r.text}`);

const before = panel.deletable;

// A FLEET THAT CHANGED SHAPE SINCE THE CALLER LOOKED AT IT INVALIDATES THE DECISION, not just the
// count. Checked before anything is clicked, and it is a refusal rather than a warning.
if (expect !== null && before !== expect) {
  console.log(
    JSON.stringify(
      { port, only, expect, deletableBefore: before, deleted: 0, refused: "expect" },
      null,
      2,
    ),
  );
  throw new Error(
    `--expect ${expect} but the panel holds ${before} deletable row(s) - refusing to touch it`,
  );
}

/** Eligible = named by `--only`, by exact id or by a prefix long enough to be an identity. */
const eligible = (id) => !!id && only.some((o) => id === o || id.startsWith(o));

const targets = panel.rows.filter((r) => eligible(r.deviceId));
const spared = panel.rows.filter((r) => !eligible(r.deviceId));
for (const r of spared) stage(`spared (not named by --only): ${r.deviceId || "(no id)"}`);

if (!only.length) {
  stage("no --only: nothing is eligible, so nothing is deleted - name what may go");
}
const unmatched = only.filter(
  (o) => !panel.rows.some((r) => r.deviceId && (r.deviceId === o || r.deviceId.startsWith(o))),
);
for (const o of unmatched) stage(`NAMED BUT ABSENT: ${o} - no row on this panel carries that id`);

let deleted = 0;
const failures = [];
const removed = [];

for (const target of targets) {
  if (dry) {
    stage(`DRY RUN - would delete ${target.deviceId} (${target.text})`);
    continue;
  }
  const remaining = (await evaluate(cx, READ_PANEL)).deletable;
  const tagged = await evaluate(cx, TAG_BY_ID(target.deviceId));
  if (tagged === null) {
    failures.push(`${target.deviceId}: row gone before it could be clicked`);
    stage(`STOP - ${target.deviceId} is no longer on the panel`);
    break;
  }
  stage(`deleting: ${target.deviceId} - ${tagged}`);
  await realClick(cx, "[data-purge-target]");
  await until(cx, `!!document.querySelector('[role="alertdialog"]')`, 15_000);
  const confirmText = await evaluate(
    cx,
    `(document.querySelector('[role="alertdialog"]').innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`,
  );
  stage(`confirm: ${confirmText}`);
  await realClick(cx, "text=Supprimer");
  // The row count falling is the post-condition. Without it a swallowed 4xx reads as a success - the
  // client turns a non-2xx into an in-panel error string and leaves the row in place.
  const dropped = await until(
    cx,
    `(function () {
       var dlg = document.querySelector('[role="dialog"]');
       if (!dlg) return false;
       return dlg.querySelectorAll(${DELETE_SEL_JS}).length < ${remaining};
     })()`,
    30_000,
  ).then(
    () => true,
    () => false,
  );
  if (!dropped) {
    const err = await evaluate(
      cx,
      `(document.querySelector('[role="dialog"]').innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`,
    );
    failures.push(`${target.deviceId}: ${err}`);
    stage(`STOP - the row did not go: ${err}`);
    break;
  }
  deleted++;
  removed.push(target.deviceId);
  await sleep(1_500);
  stage(`deleted ${deleted}/${targets.length}`);
}

const final = await evaluate(cx, READ_PANEL);
console.log(
  JSON.stringify(
    {
      port,
      only,
      expect,
      dry,
      deletableBefore: before,
      eligible: targets.map((t) => t.deviceId),
      sparedIds: spared.map((s) => s.deviceId),
      namedButAbsent: unmatched,
      deleted,
      removed,
      deletableAfter: final.deletable,
      failures,
    },
    null,
    2,
  ),
);
// The CDP socket keeps the event loop alive; without this the run never returns.
process.exit(0);
