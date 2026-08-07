/**
 * Delete every device of an account EXCEPT the one driving the browser, through the real UI.
 *
 * This is not a database purge wearing a UI costume. `purgeDeviceFootprint` is what deletes the
 * `queued_message` and `dm_device_group_memberships` rows, and it only runs on
 * `DELETE /api/mls/devices/:userId/:deviceId` - so driving the panel is the only way to find out
 * whether the product's own path really cleans up, which is the question being asked.
 *
 * The current device has no delete button at all (`{#if !isCurrentDevice}`) and the panel refuses
 * to remove the last one, so the account always keeps exactly one: the browser running this.
 *
 * Usage: node purge-devices.mjs --port 9224 [--dry]
 */
import { client } from './chat.mjs';
import { evaluate, realClick, until } from './cdp.mjs';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 9224);
const dry = argv.includes('--dry');
// A substring of the row text that must SURVIVE the purge - the live phone is a device under test,
// and deleting it would cost the campaign its Android fixture rather than clean anything up.
const keep = argv.includes('--keep') ? argv[argv.indexOf('--keep') + 1] : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) => console.log(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);

const DELETE_LABEL = "Supprimer l'appareil";
const DELETE_SEL = `[aria-label="${DELETE_LABEL}"]`;
// The label carries an apostrophe, so it can never be pasted into a single-quoted JS string sent
// over CDP - the quote closes the literal and the page throws a SyntaxError. Serialise it.
const DELETE_SEL_JS = JSON.stringify(DELETE_SEL);

/**
 * The panel's rows, read as data rather than clicked blindly - and each deletable row is read WITH
 * the text of the row it belongs to, so a device can be spared by what it says rather than by an
 * index into a list that re-renders after every deletion.
 */
const READ_PANEL = `(function () {
  var dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return { open: false, deletable: 0, rows: [] };
  var buttons = Array.prototype.slice.call(dlg.querySelectorAll(${DELETE_SEL_JS}));
  var rows = buttons.map(function (b) {
    var el = b;
    for (var i = 0; i < 8 && el; i++) {
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (/Appareil\\s*\\d/.test(t)) return t.slice(0, 120);
      el = el.parentElement;
    }
    return '(row not identified)';
  });
  return {
    open: true,
    title: (dlg.getAttribute('aria-label') || '').slice(0, 60),
    deletable: buttons.length,
    rows: rows,
    text: (dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 900),
  };
})()`;

/** Tags the first deletable row NOT matching `keep`, so realClick has a selector for exactly it. */
const TAG_TARGET = (keep) => `(function () {
  var dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  var keep = ${JSON.stringify(keep || '')};
  var prev = dlg.querySelector('[data-purge-target]');
  if (prev) prev.removeAttribute('data-purge-target');
  var buttons = Array.prototype.slice.call(dlg.querySelectorAll(${DELETE_SEL_JS}));
  for (var i = 0; i < buttons.length; i++) {
    var el = buttons[i], row = '';
    for (var j = 0; j < 8 && el; j++) {
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (/Appareil\\s*\\d/.test(t)) { row = t; break; }
      el = el.parentElement;
    }
    if (keep && row.indexOf(keep) !== -1) continue;
    buttons[i].setAttribute('data-purge-target', '1');
    return row.slice(0, 120);
  }
  return null;
})()`;

const cx = await client(port, 'canari-emse.fr');
stage(`attached on ${port}`);

// Straight to /settings. A pushState would leave the router's data untouched on this route.
await evaluate(cx, `location.href = '/settings'`);
await sleep(6_000);
await until(cx, `location.pathname === '/settings'`, 30_000);
stage(`on ${await evaluate(cx, 'location.pathname')}`);

// The card is behind `session.isLoggedIn`, i.e. behind the PIN. If the panel never opens, that is
// the reason - and it must be reported, not worked around.
const locked = await evaluate(
  cx,
  `document.body.innerText.includes('Deverrouillez la messagerie') || document.body.innerText.includes('Déverrouillez la messagerie')`
);
stage(`security card locked: ${locked}`);

await realClick(cx, 'text=Gérer');
await until(cx, `!!document.querySelector('[role="dialog"]')`, 20_000);
// The panel opens EMPTY and fills in - it renders "Synchronisation des appareils…" while the list
// loads. Reading it before that settles returns zero rows, which is indistinguishable from an
// account with no other device: the first W2 run reported "0 deletable" for an account holding
// five. So wait for the loading label to go, and for the count line to exist.
await until(
  cx,
  `(function () {
     var d = document.querySelector('[role="dialog"]');
     if (!d) return false;
     var t = d.innerText || '';
     return !t.includes('Synchronisation des appareils') &&
            (/APPAREIL\\(S\\) CONNECT/i.test(t) || t.includes('Aucun appareil'));
   })()`,
  45_000
);
await sleep(1_500);
let panel = await evaluate(cx, READ_PANEL);
stage(`panel open: ${JSON.stringify(panel).slice(0, 400)}`);

const before = panel.deletable;
let deleted = 0;
const failures = [];
const removed = [];

while (panel.deletable > 0) {
  const target = await evaluate(cx, TAG_TARGET(keep));
  if (target === null) {
    stage(`nothing left to delete that does not match --keep ${JSON.stringify(keep)}`);
    break;
  }
  if (dry) {
    stage(`DRY RUN - would delete ${panel.rows.filter((r) => !keep || !r.includes(keep)).length} devices, first: ${target}`);
    break;
  }
  const remaining = panel.deletable;
  stage(`deleting: ${target}`);
  await realClick(cx, '[data-purge-target]');
  await until(cx, `!!document.querySelector('[role="alertdialog"]')`, 15_000);
  const confirmText = await evaluate(
    cx,
    `(document.querySelector('[role="alertdialog"]').innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`
  );
  stage(`confirm: ${confirmText}`);
  await realClick(cx, 'text=Supprimer');
  // The row count falling is the post-condition. Without it a swallowed 4xx reads as a success -
  // the client turns a non-2xx into an in-panel error string and leaves the row in place.
  const dropped = await until(cx, `(function () {
    var dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return false;
    return dlg.querySelectorAll(${DELETE_SEL_JS}).length < ${remaining};
  })()`, 30_000).then(() => true, () => false);
  if (!dropped) {
    const err = await evaluate(cx, `(document.querySelector('[role="dialog"]').innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`);
    failures.push(err);
    stage(`STOP - the row did not go: ${err}`);
    break;
  }
  deleted++;
  removed.push(target);
  await sleep(1_500);
  panel = await evaluate(cx, READ_PANEL);
  stage(`deleted ${deleted}, ${panel.deletable} deletable rows left`);
}

const final = await evaluate(cx, READ_PANEL);
console.log(
  JSON.stringify(
    {
      port,
      keep,
      deletableBefore: before,
      deleted,
      removed,
      deletableAfter: final.deletable,
      failures,
      panel: final.text,
    },
    null,
    2
  )
);
// The CDP socket keeps the event loop alive; without this the run never returns.
process.exit(0);
