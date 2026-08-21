/**
 * DEL-1 - the peer deletes a group while the other side is awaiting its history.
 *
 * This is WP-HISTGHOST-1's regression check, run against PRODUCTION, and it is the only thing that
 * can say the fix RUNS: the unit tests prove the seam clears three states, a green deploy proves
 * the containers started, and neither proves that the delete a real user performs reaches the seam.
 *
 * The shape it reproduces is the one the user reported: W2 joins a group and records an
 * awaiting-history marker for it, W1 then deletes the group, W2 keeps the row (`lifecycle:
 * 'removed'` is deliberate - the UI has to be able to explain the absence) and used to keep
 * claiming, on that dead row, that its history was on the way.
 *
 * WHAT IT ASSERTS ON W2, AFTER THE DELETE:
 *   1. the row is present and marked removed          - the deliberate part, not the defect
 *   2. `mls_awaiting_history_since:<user>:<group>` is GONE   - the durable marker
 *   3. no pending-history banner text anywhere in the DOM    - the reactive phase
 *
 * Assertion 1 is what makes 2 and 3 meaningful. A run where the row simply vanished would pass 2
 * and 3 for the wrong reason, and would be a DIFFERENT behaviour from the one reported.
 *
 * The peer is resolved by ASKING THE PICKER, not by configuration: the member picker never offers
 * an existing member, so the account that answers a search on a fresh group is by construction the
 * other one. That removes the "which profile is which account" question from the check entirely.
 *
 * IT WAS WRITTEN BEFORE THE CAMPAIGN HAD A BOARD, and printed its verdict to stdout only - so DEL-1
 * read `pending` on [cross-client-testing](../../docs/wiki/cross-client-testing.md) while a runner
 * for it had existed all along, and `checks.mjs` listed the DEL phase with no scripts at all. That is
 * rule 22 exactly: a file nobody executes reads as coverage on every review. It now records like
 * every other check and is registered in the manifest.
 *
 * A CRASH BEFORE THE VERDICT STILL RECORDS NOTHING, and that is left as it is rather than papered
 * over: `run.mjs` prints `EXIT n (and recorded nothing)`, which is a LOUD and distinct state - a
 * check that died is not a check that failed, and giving the two one row would merge them.
 *
 *   node del1.mjs [--keep]     --keep leaves the group behind for manual inspection
 */
import { client, evaluate, realClick, until } from './chat.mjs';
import { usernames } from './accounts.mjs';
import { mark, record } from './results.mjs';
import { gate, report, watch } from './watch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// THE CAMPAIGN'S OWN STAMP, so the group this check leaves behind on a failure is recognisable as
// debris from a named run rather than as a group somebody made by hand.
const run = mark('DEL1');
const NAME = run;
const keep = process.argv.includes('--keep');

const W1 = await client(9224, 'canari-emse.fr', { focus: false });
const W2 = await client(9223, 'canari-emse.fr', { focus: false });

// FROM THE FIRST GESTURE, not from the delete: what a run leaves in the console is evidence about
// the whole flow, and a window opened at the verdict would miss the join that armed it.
const wa = await watch(W1, 'W1');
const wb = await watch(W2, 'W2');

/** Closes whatever overlay is open, by that overlay's own control. See `invite.mjs`. */
const overlay = (cx) =>
  evaluate(
    cx,
    `(function () {
      var t = document.body.innerText;
      if (document.querySelector('#new-group-name')) return 'new-conversation';
      if (/Envoyer l'invitation/.test(t)) return 'add-member';
      if (/Quitter le groupe/.test(t)) return 'group-panel';
      return 'none';
    })()`
  );
const settle = async (cx) => {
  for (let i = 0; i < 4; i++) {
    const state = await overlay(cx);
    if (state === 'none') return;
    await realClick(cx, state === 'group-panel' ? 'text=Fermer les paramètres du groupe' : 'text=Fermer').catch(
      () => {}
    );
    await sleep(1200);
  }
  const left = await overlay(cx);
  if (left !== 'none') throw new Error(`could not close the overlay, still on ${left}`);
};

/**
 * The group id of the conversation called `name`, read from the store that actually holds it.
 *
 * NOT FROM THE URL. This app routes every conversation to a bare `/chat` and keeps the selection in
 * a store, so `location` carries no id at all - a UUID matcher over `location.pathname` returns
 * null for every conversation, always, and a check built on it silently measures nothing. That is
 * how `heal-w2.mjs` came to scope a marker lookup by an id it never had.
 */
const groupIdByName = async (cx, name) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        const open = (n) => new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); setTimeout(() => res(null), 4000); });
        const dbs = (await indexedDB.databases()).filter((d) => d.name.indexOf('CanariDB_') === 0 && d.name.indexOf('Mls') === -1);
        for (const d of dbs) {
          const db = await open(d.name);
          if (!db) continue;
          if (db.objectStoreNames.contains('conversations')) {
            const rows = await new Promise((res) => { const rq = db.transaction('conversations', 'readonly').objectStore('conversations').getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
            const hit = rows.find((r) => String(r.name ?? r.title ?? r.displayName ?? '') === ${JSON.stringify(
              name
            )});
            if (hit) { db.close(); return JSON.stringify({ id: hit.groupId ?? hit.id ?? null, lifecycle: hit.lifecycle ?? null }); }
          }
          db.close();
        }
        return JSON.stringify(null);
      })()`
    )
  );

/**
 * The three states WP-HISTGHOST-1 is about, read on one browser for one group - PLUS the lifecycle.
 *
 * The lifecycle is what separates the two causes this check cannot otherwise tell apart. A run that
 * ends with a surviving marker means either "the delete reached this device and the seam that
 * clears the marker did not run" or "the delete never reached this device at all" - a far bigger
 * defect, and a different fix. Reporting only the marker sends the reader to the wrong one.
 */
const historyState = async (cx, groupId) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        var gid = ${JSON.stringify(groupId)};
        var keys = Object.keys(localStorage).filter(function (k) {
          return k.indexOf('mls_awaiting_history_since:') === 0 && k.indexOf(gid) !== -1;
        });
        var body = document.body.innerText.replace(/\\s+/g, ' ');
        var open = (n) => new Promise((res) => { var r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); setTimeout(() => res(null), 4000); });
        var lifecycle = 'NO ROW';
        var dbs = (await indexedDB.databases()).filter((d) => d.name.indexOf('CanariDB_') === 0 && d.name.indexOf('Mls') === -1);
        for (var i = 0; i < dbs.length; i++) {
          var db = await open(dbs[i].name);
          if (!db) continue;
          if (db.objectStoreNames.contains('conversations')) {
            var rows = await new Promise((res) => { var rq = db.transaction('conversations', 'readonly').objectStore('conversations').getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
            var hit = rows.find((r) => (r.groupId ?? r.id) === gid);
            if (hit) lifecycle = hit.lifecycle ?? 'ACTIVE (no lifecycle field)';
          }
          db.close();
        }
        var m = body.match(/L'historique est en attente[^.]*/);
        return JSON.stringify({
          marker: keys.length ? localStorage.getItem(keys[0]) : null,
          banner: m ? m[0].slice(0, 90) : null,
          lifecycle: lifecycle,
          rowPresent: body.indexOf(${JSON.stringify(NAME)}) !== -1,
        });
      })()`
    )
  );

// --- 1. W1 creates the group -------------------------------------------------------------------
await settle(W1);
if ((await evaluate(W1, 'location.pathname')) !== '/chat') {
  await evaluate(W1, `location.href = '/chat'`);
  await sleep(5000);
}
await realClick(W1, '[aria-label="Nouvelle discussion"]');
await sleep(1500);
await realClick(W1, 'text=Groupe');
await sleep(1000);
await realClick(W1, '#new-group-name');
await W1.send('Input.insertText', { text: NAME });
await sleep(600);
await realClick(W1, 'text=Créer le groupe');
await until(W1, `document.body.innerText.indexOf(${JSON.stringify(NAME)}) !== -1`, 25000);
await sleep(2500);
console.log(`[del1] created ${NAME}`);

// --- 2. W1 fills the group with history BEFORE the peer exists in it ---------------------------
//
// THE ORDER IS THE CHECK. The first passing run sent these messages after the invite, so W2 got
// every one of them live, was missing nothing, and recorded no awaiting-history marker - the run
// went green having never armed the precondition it exists to test. A marker is written when a
// device finds it lacks history the peer holds, and the only way to produce that honestly is for
// the history to predate the join.
const { openGroup } = await import('./groupnav.mjs');
await openGroup(W1, NAME, { navigate: true, label: 'del1' });
await sleep(1500);
const row = await groupIdByName(W1, NAME);
const groupId = row?.id;
if (!groupId) throw new Error(`no conversation row named ${NAME} in W1's store`);
console.log(`[del1] group id ${groupId.slice(0, 8)}...`);

for (const text of ['DEL1 pre one', 'DEL1 pre two', 'DEL1 pre three']) {
  await realClick(W1, '[aria-label="Message"], textarea, [contenteditable=true]').catch(() => {});
  await W1.send('Input.insertText', { text });
  await sleep(400);
  await realClick(W1, '[aria-label="Envoyer le message"]');
  await sleep(1500);
}
console.log(`[del1] three messages sent BEFORE the invite`);

// --- 3. W1 invites the peer --------------------------------------------------------------------
await realClick(W1, '[aria-label="Paramètres du groupe"]');
await until(W1, `/Quitter le groupe/.test(document.body.innerText)`, 10000);
await sleep(1200);
await realClick(W1, 'text=Ajouter');
await sleep(1800);

const candidates = usernames();

/**
 * WHICH ACCOUNT IS THE PEER IS DECIDED BY THE ROSTER, NOT BY PARSING A NAME OFF THE PAGE.
 *
 * The picker offers users who are ALREADY members, this browser's own account included, and
 * submitting an invitation for one of them closes the picker exactly like a real invitation while
 * changing nothing - so "the first option in the list" invited the account the script was running
 * as, twice, and then waited for a peer that had never been invited.
 *
 * Two name heuristics were tried to tell self from peer and both read the wrong substring off
 * `innerText` (first a panel label, then "Ajouter <owner>" - the button's own caption, which names
 * this browser's account rather than the other one): the page is not a data source, it is a
 * rendering. So the candidates are simply tried in turn and the ONLY thing believed is the roster
 * going from one member to two. That is the post-condition the check needs anyway, it cannot be
 * satisfied by the wrong account, and it costs one short failed attempt in the worst case.
 */
const trySearch = async (q) => {
  await evaluate(
    W1,
    `(function () {
      var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) { return /rechercher/i.test(x.placeholder || ''); }).pop();
      if (i) { i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`
  );
  await W1.send('Input.insertText', { text: q });
  await sleep(3000);
  return JSON.parse(
    await evaluate(
      W1,
      `(function () {
        var list = [].slice.call(document.querySelectorAll('ul, ol')).filter(function (e) {
          return (e.innerText || '').length < 400 && /fixed/.test((e.className || '').toString()) && (e.innerText || '').trim();
        })[0];
        if (!list) return JSON.stringify(null);
        var opt = list.querySelector('li, button, [role=option]') || list.firstElementChild;
        if (!opt) return JSON.stringify(null);
        var r = (opt.querySelector('button, [role=option]') || opt).getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (opt.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40) });
      })()`
    )
  );
};

const rosterCount = async () =>
  Number(
    await evaluate(
      W1,
      `(function () { var m = document.body.innerText.match(/MEMBRES \\((\\d+)\\)/); return m ? m[1] : '0'; })()`
    )
  );

let invited = null;
for (const q of candidates) {
  const hit = await trySearch(q);
  if (!hit) continue;
  console.log(`[del1] trying ${JSON.stringify(q)} -> option ${JSON.stringify(hit.text)}`);
  await W1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased'])
    await W1.send('Input.dispatchMouseEvent', {
      type,
      x: hit.x,
      y: hit.y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  await sleep(1200);
  const enabled = await evaluate(
    W1,
    `(function () {
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /Envoyer l'invitation/.test(x.innerText || ''); })[0];
      return !!b && !b.disabled;
    })()`
  );
  if (!enabled) continue;
  await realClick(W1, "text=Envoyer l'invitation");
  await until(W1, `!/Envoyer l'invitation/.test(document.body.innerText)`, 25000).catch(() => {});
  await until(W1, `/MEMBRES \\(2\\)/.test(document.body.innerText)`, 20000).catch(() => {});
  if ((await rosterCount()) === 2) {
    invited = hit.text;
    break;
  }
  console.log(`[del1] ${JSON.stringify(hit.text)} left the roster at ${await rosterCount()} - not the peer`);
  await realClick(W1, 'text=Ajouter').catch(() => {});
  await sleep(1500);
}
if (!invited) throw new Error('no candidate account could be added to the group');
await sleep(3000);
await settle(W1);
console.log(`[del1] peer invited: ${JSON.stringify(invited)} - roster is at 2 (Add commit merged)`);

// --- 4. W2 joins, and we read its three states BEFORE the delete -------------------------------
await until(W2, `document.body.innerText.indexOf(${JSON.stringify(NAME)}) !== -1`, 60000);
await openGroup(W2, NAME, { navigate: true, label: 'del1' });
await sleep(8000);
const before = await historyState(W2, groupId);
console.log(`[del1] W2 BEFORE delete: ${JSON.stringify(before)}`);
// A RUN THAT NEVER ARMED THE PRECONDITION MUST NOT REPORT PASS. Without a marker or a banner on
// W2 there is nothing for the delete to clear, and the three assertions below would hold on a
// build with the fix reverted - which is the definition of a check that measures nothing.
const armed = before.marker !== null || before.banner !== null;
if (!armed) console.log('[del1] NOT ARMED - W2 recorded no awaiting-history state; the verdict below is VACUOUS');

// --- 5. W1 deletes the group -------------------------------------------------------------------
await openGroup(W1, NAME, { navigate: true, label: 'del1' });
await realClick(W1, '[aria-label="Paramètres du groupe"]');
await until(W1, `/Supprimer le groupe/.test(document.body.innerText)`, 10000);
await sleep(1000);
if (keep) {
  console.log('[del1] --keep: stopping before the delete');
  process.exit(0);
}
await realClick(W1, 'text=Supprimer le groupe');
await sleep(2000);
// The destructive control confirms. Take whatever confirmation surface is up, by its own label.
const confirmed = await evaluate(
  W1,
  `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
      return /^(Supprimer|Confirmer|Oui)/.test((x.innerText || '').trim()) && !x.disabled;
    });
    return JSON.stringify(b.map(function (x) { return (x.innerText || '').trim().slice(0, 30); }));
  })()`
);
console.log(`[del1] confirmation surfaces: ${confirmed}`);
await realClick(W1, 'text=Supprimer').catch(() => {});
await until(W1, `document.body.innerText.indexOf(${JSON.stringify(NAME)}) === -1`, 30000).catch(() => {});
await sleep(4000);
console.log(`[del1] W1 deleted the group`);

// --- 6. W2's verdict ---------------------------------------------------------------------------
//
// OPEN THE DEAD ROW BEFORE READING. The reported symptom was a banner ON a conversation the peer
// had deleted and that the UI deliberately keeps - so the surface under test is that row's own
// view, and a reading taken from wherever the app happened to be left is a reading of some other
// conversation's banner.
await sleep(8000);
await openGroup(W2, NAME, { navigate: true, label: 'del1' }).catch(() => {});
await sleep(3000);
const after = await historyState(W2, groupId);
console.log(`[del1] W2 AFTER delete:  ${JSON.stringify(after)}`);

const fail = [];
if (after.marker !== null) fail.push('the durable awaiting-history marker survived the delete');
if (after.banner !== null) fail.push(`a history banner is still on screen: ${after.banner}`);

const expectations = {
  // The deliberate part, and what makes the other two mean anything: a row that simply vanished
  // would satisfy them for the wrong reason and would be a DIFFERENT behaviour from the reported one.
  theRowIsKeptAndMarkedRemoved: after.lifecycle === 'removed',
  theDurableMarkerIsGone: after.marker === null,
  noHistoryBannerSurvives: after.banner === null,
};

const verdict = !armed ? 'VACUOUS' : fail.length > 0 ? 'FAIL' : 'PASS';
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('DEL-1', gated.verdict, {
  ...gated.detail,
  group: NAME,
  groupId,
  armed,
  before,
  after,
  ...expectations,
  failures: fail,
});
console.log(`[del1] VERDICT ${gated.verdict}${fail.length ? ' - ' + fail.join('; ') : ''}`);

W1.close?.();
W2.close?.();
process.exit(gated.verdict === 'PASS' ? 0 : 1);
