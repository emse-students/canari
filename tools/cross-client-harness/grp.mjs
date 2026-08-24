#!/usr/bin/env node
/**
 * GRP-1..10 - group membership: the roster, the TWO different departures, the invitation link, and
 * what each of them leaves behind on the other side.
 *
 * WHAT THE APP ACTUALLY PROMISES, read off `frontend/src/lib/utils/chat/groupActions.ts` and
 * `ChatGroupPanel.svelte` rather than guessed - the two departures are not the same operation and
 * several checks here turn on the difference:
 *
 *   ADD (`addMember` -> `deliverWelcomes`): a real MLS Add commit. The epoch moves for everyone and
 *     the invitee gets a Welcome. This is the campaign's only cheap, deterministic epoch generator
 *     (`invite.mjs` says so, and it is still true).
 *   REMOVE (`removeMemberAndBroadcast`): a real MLS **Remove commit** - "removes the member's leaf
 *     for all remaining members" - then a `memberRemoved` notice, then a best-effort server-registry
 *     clean. Because the commit is authoritative, the removed device cannot read what is sent after
 *     it and KEEPS what it had already decrypted. GRP-3 asserts both halves; asserting only the
 *     first would pass against a client that had simply wiped the conversation.
 *   LEAVE (`leaveGroupAndBroadcast`): deliberately **no commit**. Its own docstring: "the member's
 *     leaf remains in others' trees until the next commit, but they no longer receive messages
 *     (server-side)". The guarantee is SERVER-SIDE, not cryptographic, so GRP-6 asserts the
 *     observable consequence and says nothing about a tree it cannot see.
 *   INVITE LINK (`generateShareLink`): `publicAppUrl('/g/join/<token>')`, written to the clipboard.
 *     The panel's own copy states the delivery condition - the joiner is added "des qu'un membre est
 *     en ligne" - so a joiner needs a member online, which W1 is throughout.
 *
 * WHAT `grp-traffic.mjs` USED TO DO IS FOLDED INTO GRP-1. That script was the whole GRP phase in
 * `checks.mjs`, recorded a `GRP-TRAFFIC` id that appears on no board row, and hard-coded a group
 * name from 2026-08-15 that the estate sweep has since deleted - so the one script the phase had
 * would have thrown on its first line. Its subject was worth keeping: after a commit the STORED id
 * sets on both sides must converge, and a rendered marker alone cannot say that.
 *
 * THE PANEL'S SURFACES ARE ADDRESSED BY THEIR OWN HOOKS, all read off the running build before a
 * line of this was written:
 *   - the roster count is the panel's `MEMBRES (N)` heading (`chat_group_members_count_label`);
 *   - each member's remove control is `[aria-label="Retirer <userId>"]`, the only per-member hook
 *     the panel offers - see GRP-9, where being the only hook is also the finding;
 *   - the rename field is `#group-rename-input` with a `Valider` submit;
 *   - leaving is TWO steps (`Quitter le groupe` -> `Quitter ce groupe ?` -> `Quitter`) and so is
 *     deleting. A check that clicks once and waits is a 30-second timeout blaming the product.
 *
 *   node grp.mjs --only 3
 */
import {
  awaitMessage,
  client,
  countMessage,
  ensureChat,
  evaluate,
  goto,
  realClick,
  send,
  until,
} from './chat.mjs';
import { addMember, openGroupSettings } from './addmember.mjs';
import { closeOverlays, createGroup, deleteGroup, openGroup } from './groupnav.mjs';
import { armCut, cutHard } from './net.mjs';
import { mark, record, recordObserved } from './results.mjs';
import { awaitLine, consoleLines, ignoringOfflineCut, report, watch } from './watch.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { W1, W2 } = PORTS;

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

/** How long an absence is watched before it is called an absence. */
const NEGATIVE_WINDOW_MS = 30_000;

/**
 * A CLIENT AND THE OBSERVER THAT WATCHES IT, in one call - the twin of `mention.mjs`'s.
 *
 * A membership commit is the one operation in this app that can fail on a client OTHER than the one
 * that performed it: W1 stages and merges, and it is W2 whose tree has to accept the result. Every
 * way that goes wrong - a Welcome for an epoch already past, a commit applied out of order, a leaf
 * that duplicates - says so in the receiver's console and nowhere else. A roster count cannot.
 */
async function observed(port, label) {
  const cx = await client(port);
  return [cx, await watch(cx, label)];
}

/**
 * The open group panel as a reader sees it: the roster count, the visible rows, the removable ids.
 *
 * `String.raw` because this expression carries regex escapes. Written the ordinary way, `\s` inside
 * a template literal reaches the page as the LETTER s - the bug documented at length in
 * `addmember.mjs`, which once stripped every s out of a display name and split a sidebar row in two.
 */
const PANEL = String.raw`(function () {
  var t = document.body.innerText;
  var m = /MEMBRES\s*\((\d+)\)/i.exec(t);
  var from = t.search(/MEMBRES\s*\(/i);
  var to = t.indexOf('Quitter le groupe');
  var seg = from !== -1 && to > from ? t.slice(from, to) : '';
  var rows = seg.split('\n').map(function (s) { return s.trim(); }).filter(function (s) {
    return s && !/^MEMBRES/i.test(s) && s !== 'Ajouter';
  });
  var removes = [].slice.call(document.querySelectorAll('button, [role=button]'))
    .map(function (b) { return (b.getAttribute('aria-label') || b.innerText || '').trim(); })
    .filter(function (s) { return s.indexOf('Retirer ') === 0; })
    .map(function (s) { return s.slice(8); });
  return JSON.stringify({ count: m ? Number(m[1]) : null, rows: rows, removableIds: removes });
})()`;

/** The panel's invite-link state - the value, and which of the two buttons it is offering. */
const SHARE = String.raw`(function () {
  var t = document.body.innerText;
  var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) {
    return /\/g\/join\//.test(x.value || '');
  })[0];
  return JSON.stringify({
    value: i ? i.value : null,
    offersGenerate: t.indexOf('Générer un lien') !== -1,
    offersRegenerate: t.indexOf('Régénérer') !== -1,
    saysCopied: t.indexOf('Lien copié') !== -1,
    error: /Échec de la génération du lien/.test(t)
  });
})()`;

/** Reads the panel of the group already open, opening the panel first if it is not up. */
async function panelOf(cx) {
  if (!(await evaluate(cx, `/Quitter le groupe/.test(document.body.innerText)`))) {
    await openGroupSettings(cx);
  }
  return JSON.parse(await evaluate(cx, PANEL));
}

/**
 * Removes one member by id and returns once the roster has actually shrunk.
 *
 * THE POST-CONDITION IS THE ROSTER, not the click: a Remove is a commit and a network round trip,
 * exactly as an Add is, and `addmember.mjs` learnt that same lesson one gesture earlier.
 */
async function removeMember(cx, userId) {
  const before = (await panelOf(cx)).count;
  await realClick(cx, `[aria-label="Retirer ${userId}"]`);
  await until(cx, `/MEMBRES\\s*\\(${before - 1}\\)/i.test(document.body.innerText)`, 25000);
  await sleep(2000);
}

/**
 * Leaves the open group, through BOTH steps the panel requires.
 *
 * `Quitter le groupe` only arms a confirmation (`confirmLeave` in `ChatGroupPanel.svelte`); the
 * button that calls `onGroupLeave` is the `Quitter` inside it.
 */
async function leaveGroup(cx, name) {
  await realClick(cx, 'text=Quitter le groupe');
  // CASE-INSENSITIVE, because the confirmation is a `<p class="... uppercase">` and `innerText`
  // returns what CSS renders: "QUITTER CE GROUPE ?". The exact-case test timed out on every run of
  // GRP-6 and read as the product refusing to arm its own confirmation.
  await until(cx, `/quitter ce groupe/i.test(document.body.innerText)`, 8000);
  await realClick(cx, 'text=Quitter');
  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) === -1`, 30000);
  await sleep(2000);
}

/** Renames the open group and returns once the panel has closed - `submitRename` closes it. */
async function renameGroup(cx, to) {
  await realClick(cx, '#group-rename-input');
  await evaluate(
    cx,
    `(function () {
      var i = document.querySelector('#group-rename-input');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await cx.send('Input.insertText', { text: to });
  await realClick(cx, 'text=Valider');
  await until(cx, `!/Quitter le groupe/.test(document.body.innerText)`, 15000);
  await sleep(2500);
}

/**
 * A group that exists for the duration of one check and is deleted whatever happens to it.
 *
 * `deleteGroup` in a `finally`, because a check that dies mid-way is exactly the case that leaves a
 * LIVE group behind - the shape `cleanup.mjs` measured on 2026-08-21, where the only two live
 * throwaway groups on prod were both from runs that died at the invite step.
 */
async function withGroup(cx, n, fn) {
  const name = mark(`GRP${n}`);
  await closeOverlays(cx);
  await createGroup(cx, name, { label: `grp${n}` });
  await openGroup(cx, name, { navigate: false, label: `grp${n}` });
  try {
    return await fn(name);
  } finally {
    await closeOverlays(cx).catch(() => {});
    await deleteGroup(cx, name).catch((e) => console.log(`[grp] teardown: ${e.message}`));
  }
}

/**
 * Adds the peer to the group whose pane is open, from WHATEVER overlay state the caller is in.
 *
 * `addMember`'s `openSettings` is a boolean the caller has to get right, and on GRP's first run six
 * checks got it wrong the same way: `withGroup` leaves the group OPEN but its settings panel CLOSED,
 * so `{ openSettings: false }` sent `openPicker` looking for an `Ajouter` that is inside the panel
 * it did not open. Six `no stable element for selector: text=Ajouter` errors, all of them the
 * harness. `panelOf` already normalises that state - it opens the panel only if it is not up - so
 * the precondition is established rather than assumed, once, here.
 */
async function addPeer(cx) {
  await panelOf(cx);
  return addMember(cx, PEER_NAME, { openSettings: false });
}

/**
 * Whether a SIDEBAR ROW names this group - which is what "the group reached this client" means.
 *
 * `document.body.innerText.indexOf(name)` is not that, and GRP-4 proved it: the invitation page at
 * `/g/join/<token>` renders "Vous avez ete invite(e) a rejoindre le groupe <name>", so the body
 * contained the name the instant the joiner opened the LINK - the check recorded
 * `joinerSawGroupMs: 1` for a group it had not joined and never would. A row is a control; the
 * invitation page's heading is not, which separates the two cleanly.
 */
const lists = (cx, name) =>
  evaluate(
    cx,
    `[].slice.call(document.querySelectorAll('button, [role=button], a, li')).some(function (e) {
      return (e.innerText || '').indexOf(${JSON.stringify(name)}) !== -1 && e.getBoundingClientRect().width > 0;
    })`
  );

/** Waits for `name` to appear on a client and reports how long it took - or null if it never did. */
async function awaitListed(cx, name, timeoutMs = 45000) {
  const t0 = Date.now();
  try {
    await until(
      cx,
      `[].slice.call(document.querySelectorAll('button, [role=button], a, li')).some(function (e) {
        return (e.innerText || '').indexOf(${JSON.stringify(name)}) !== -1 && e.getBoundingClientRect().width > 0;
      })`,
      timeoutMs
    );
    return Date.now() - t0;
  } catch {
    return null;
  }
}

/**
 * The messages this client has STORED for a conversation, as `{ id, ts }` - never their content.
 *
 * THE ROWS ARE CIPHERTEXT AT REST (`id, conversationId, timestamp, iv, cipherText`), so a surplus
 * row cannot be classified by what it says. The TIMESTAMP can classify it, which is what GRP-1
 * needs: `recon.mjs` recorded on 2026-08-15 that an invitee holds one row the inviter does not, and
 * this probe reproduces it exactly - after one message, W1 held one row and W2 held two. Whether
 * that surplus is the invitation event or a message the SENDER lost is the whole question, and the
 * clock answers it: an event minted at the add predates every message sent after the add.
 */
const storedIds = async (cx, name) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        var open = function (n) {
          return new Promise(function (res) {
            var r = indexedDB.open(n);
            r.onsuccess = function () { res(r.result); };
            r.onerror = function () { res(null); };
            setTimeout(function () { res(null); }, 4000);
          });
        };
        var dbs = (await indexedDB.databases()).filter(function (x) {
          return x.name.indexOf('CanariDB_') === 0 && x.name.indexOf('Mls') === -1;
        });
        if (!dbs.length) return JSON.stringify({ err: 'no app database' });
        var db = await open(dbs[0].name);
        var getAll = function (s) {
          return new Promise(function (res) {
            var rq = db.transaction(s, 'readonly').objectStore(s).getAll();
            rq.onsuccess = function () { res(rq.result || []); };
            rq.onerror = function () { res([]); };
          });
        };
        var convo = (await getAll('conversations')).find(function (c) {
          return String(c.name || '') === ${JSON.stringify(name)};
        });
        if (!convo) { db.close(); return JSON.stringify({ err: 'no such conversation' }); }
        var id = String(convo.groupId || convo.id);
        var rows = (await getAll('messages')).filter(function (m) {
          return String(m.conversationId) === id;
        }).map(function (m) { return { id: String(m.id), ts: Number(m.timestamp) || 0 }; });
        db.close();
        return JSON.stringify({ id: id, rows: rows });
      })()`
    )
  );

// ---------------------------------------------------------------------------------------------

/**
 * GRP-1 - create a group, add a member, both sides see the roster, and the Add commit MERGES.
 *
 * "Merges" is the part a roster cannot show. A commit that staged but never merged leaves W1's own
 * panel reading 2 while nothing it sends afterwards can be decrypted by anyone - so the check sends
 * one message from each side after the add, requires both to arrive, AND requires the stored id sets
 * to converge. Traffic in both directions was `grp-traffic.mjs`'s subject, folded in here.
 */
async function grp1() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withGroup(w1, 1, async (name) => {
      const alone = await panelOf(w1);
      await addPeer(w1);
      const after = await panelOf(w1);
      await closeOverlays(w1);

      const reachedPeerMs = await awaitListed(w2, name);
      let peerCount = null;
      if (reachedPeerMs !== null) {
        await openGroup(w2, name, { navigate: false, label: 'grp1-w2' });
        peerCount = (await panelOf(w2)).count;
        await closeOverlays(w2);
      }

      // THE MOMENT THE COMMIT LANDED, which is what separates the invitee's invitation row from a
      // message the sender lost - everything below is sent strictly after it.
      const addedAt = Date.now();
      const fromW1 = mark('GRPA');
      const fromW2 = mark('GRPB');
      await openGroup(w1, name, { navigate: false, label: 'grp1-w1' });
      await send(w1, fromW1);
      const w2GotW1 =
        reachedPeerMs !== null &&
        (await awaitMessage(w2, fromW1, 30000).then(
          () => true,
          () => false
        ));
      if (reachedPeerMs !== null) await send(w2, fromW2);
      const w1GotW2 =
        reachedPeerMs !== null &&
        (await awaitMessage(w1, fromW2, 30000).then(
          () => true,
          () => false
        ));

      await sleep(2500);
      const stored = { W1: await storedIds(w1, name), W2: await storedIds(w2, name) };
      const w1Rows = stored.W1?.rows ?? [];
      const w2Rows = stored.W2?.rows ?? [];
      const w2Ids = new Set(w2Rows.map((r) => r.id));

      // NOTHING THE SENDER HOLDS MAY BE MISSING ON THE RECEIVER. That is the direction a loss takes,
      // and it is asserted as set inclusion rather than as equality - equality would fail on the
      // invitee's invitation row, which is not a loss and which the campaign has known about since
      // `recon.mjs` first flagged it.
      const missingOnPeer = w1Rows.filter((r) => !w2Ids.has(r.id)).map((r) => r.id.slice(0, 8));

      // AND THE SURPLUS MUST PREDATE THE COMMIT. A row the invitee minted at the invitation is
      // expected; a row appearing on one side only AFTER the traffic started is a divergence, and
      // the two are indistinguishable without the clock.
      const w1Ids = new Set(w1Rows.map((r) => r.id));
      const surplus = w2Rows.filter((r) => !w1Ids.has(r.id));
      const surplusAfterCommit = surplus.filter((r) => r.ts > addedAt).map((r) => r.id.slice(0, 8));

      const ok =
        alone.count === 1 &&
        after.count === 2 &&
        peerCount === 2 &&
        w2GotW1 &&
        w1GotW2 &&
        missingOnPeer.length === 0 &&
        surplusAfterCommit.length === 0;
      await recordObserved(
        'GRP-1',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          rosterOnCreator: { beforeAdd: alone.count, afterAdd: after.count, rows: after.rows },
          reachedPeerMs,
          rosterOnPeer: peerCount,
          deliveredAfterCommit: { w2GotW1, w1GotW2 },
          storedRowCounts: { W1: w1Rows.length, W2: w2Rows.length },
          missingOnPeer, // must be empty - this is what a lost message looks like
          peerSurplusRows: surplus.length, // expected: the invitation event, one per group
          peerSurplusMintedAfterTheCommit: surplusAfterCommit, // must be empty - a real divergence
        },
        { W1: o1, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-2 - the picker offers neither an existing member nor yourself, and a no-op cannot succeed.
 *
 * THE THREE ARE ONE CHECK because they are one guarantee: the only names the picker may offer are
 * the ones an Add commit could actually add. Offering a member already in the tree is how a
 * duplicate leaf is created, which the product carries a whole repair path for
 * (`handleDuplicateLeafError`) - and a repair path is not a reason to allow the gesture.
 *
 * The no-op half is asserted on the CONTROL, not on a toast: `Envoyer l'invitation` must be disabled
 * with nothing selected. A success message for an empty submission is the shape that teaches a user
 * an invitation was sent when no commit ever happened.
 */
async function grp2() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  try {
    await ensureChat(w1);
    return await withGroup(w1, 2, async (name) => {
      await addPeer(w1);
      await closeOverlays(w1);
      await openGroup(w1, name, { navigate: false, label: 'grp2' });
      await openGroupSettings(w1);
      await realClick(w1, 'text=Ajouter');
      await sleep(1800);

      /** True when the portalled result list offers `who` - the same selector `addmember.mjs` uses. */
      const offered = async (who) => {
        const field = await evaluate(
          w1,
          `(function () {
            var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) {
              return /rechercher/i.test(x.placeholder || '');
            }).pop();
            if (!i) return null;
            i.focus();
            i.value = '';
            i.dispatchEvent(new Event('input', { bubbles: true }));
            return i.id || 'NO_ID';
          })()`
        );
        if (!field) throw new Error('grp2: no search field in the member picker');
        if (field !== 'NO_ID') await realClick(w1, `#${field}`);
        await w1.send('Input.insertText', { text: who });
        await sleep(2500);
        return JSON.parse(
          await evaluate(
            w1,
            `(function () {
              var want = ${JSON.stringify(who.toLowerCase())};
              var list = [].slice.call(document.querySelectorAll('ul, ol')).filter(function (e) {
                var t = (e.innerText || '').toLowerCase();
                return t.indexOf(want) !== -1 && t.length < 400 && /fixed/.test((e.className || '').toString());
              })[0];
              return JSON.stringify(!!list);
            })()`
          )
        );
      };

      const offersExistingMember = await offered(PEER_NAME);
      const offersSelf = await offered(OWNER_NAME);

      // NOTHING SELECTED: clear the query so no option is highlighted, then read the submit.
      await evaluate(
        w1,
        `(function () {
          var i = [].slice.call(document.querySelectorAll('input')).filter(function (x) {
            return /rechercher/i.test(x.placeholder || '');
          }).pop();
          if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }
          return true;
        })()`
      );
      await sleep(1500);
      const submit = JSON.parse(
        await evaluate(
          w1,
          `JSON.stringify((function () {
            var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
              return /Envoyer l'invitation/.test(x.innerText || '');
            })[0];
            return { present: !!b, disabled: b ? !!b.disabled : null };
          })())`
        )
      );

      await closeOverlays(w1);
      await openGroup(w1, name, { navigate: false, label: 'grp2' });
      const roster = await panelOf(w1);
      await closeOverlays(w1);

      const ok =
        !offersExistingMember &&
        !offersSelf &&
        submit.present &&
        submit.disabled === true &&
        roster.count === 2;
      await recordObserved(
        'GRP-2',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          offersExistingMember,
          offersSelf,
          emptySubmit: submit,
          rosterUnchanged: roster.count,
        },
        { W1: o1 }
      );
      return ok;
    });
  } finally {
    w1.close();
  }
}

/**
 * GRP-3 - remove a member: the Remove commit, and what the removed device can still read.
 *
 * BOTH HALVES OR THE CHECK PROVES NOTHING. A client that reacted to `memberRemoved` by wiping the
 * conversation would satisfy "cannot read what came after" while violating the actual guarantee -
 * MLS gives forward secrecy, not retroactive erasure, and a message the device already decrypted is
 * the device's. So the check requires the BEFORE marker to still be there and the AFTER marker never
 * to arrive.
 *
 * The negative is a deadline, which is the only honest way to assert an absence: 30 s after a send
 * that a live member sees in about 120 ms.
 *
 * SINCE 2026-08-23 IT ALSO ASSERTS WHAT THE REMOVED DEVICE DOES ABOUT IT, which is where this row
 * found a real defect on its first armed run. The removed client used to treat a legitimate removal
 * as a broken state: it asked to be re-added, requested the group's commits, and learnt from a 403
 * what the Remove commit had already told it. Fixed by reading membership off the commit
 * (`is_group_active`), so the two things asserted here are that the eviction WAS learnt that way,
 * and that nothing asked to come back. The second is the load-bearing one - a client that says
 * `[EVICT]` and then re-adds itself anyway would satisfy the first alone.
 */
async function grp3() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withGroup(w1, 3, async (name) => {
      const ownerIds = (await panelOf(w1)).removableIds;
      await addPeer(w1);
      const both = await panelOf(w1);
      await closeOverlays(w1);
      const peerId = both.removableIds.find((id) => !ownerIds.includes(id)) ?? null;
      if (!peerId) throw new Error('grp3: could not identify the peer among the removable ids');

      await awaitListed(w2, name);
      await openGroup(w2, name, { navigate: false, label: 'grp3-w2' });
      await openGroup(w1, name, { navigate: false, label: 'grp3-w1' });

      const before = mark('GRPBEF');
      await send(w1, before);
      const peerReadBefore = await awaitMessage(w2, before, 30000).then(
        () => true,
        () => false
      );

      await openGroupSettings(w1);
      await removeMember(w1, peerId);
      const afterRemoval = await panelOf(w1);
      await closeOverlays(w1);

      const after = mark('GRPAFT');
      await openGroup(w1, name, { navigate: false, label: 'grp3-w1' });
      await send(w1, after);
      await sleep(NEGATIVE_WINDOW_MS);

      const peerStillHasBefore = Number(await countMessage(w2, before)) > 0;
      const peerGotAfter = Number(await countMessage(w2, after)) > 0;

      // WHAT THE REMOVED DEVICE DID ABOUT IT. Read from W2's own log, before `recordObserved`
      // drains the window - `report` is the classifier and a verdict must never be computed over a
      // projection of its own evidence (see `consoleLines`).
      //
      // The positive has a deadline for the same reason the negative above does: the commit travels
      // after the click that made it, so reading the instant `removeMember` returns is a race.
      const evictLine = await awaitLine(o2.cx, '[EVICT] Removed from', 15000);
      // EVIDENCE, NOT AN ASSERTION, and the difference is the point. The guard added on 2026-08-24
      // fires only when the removed device SELECTS its retired conversation, which this check does
      // not control - the 403 it replaces was intermittent for exactly that reason. Asserting the
      // line would make a correct run fail whenever the selection did not happen; omitting it
      // entirely would leave a clean GRP-3 unable to say whether it was clean because the guard held
      // or clean because the path was never walked. So it is recorded, and the row separates them.
      const rosterGuard = consoleLines(o2.cx).some((l) => /\[VERIFY\] Roster of .* not requested/.test(l));
      // The negative needs no deadline of its own: it is read after that window AND after the
      // 30 s negative window, so anything a removal was going to provoke has had time to appear.
      const cameBack = consoleLines(o2.cx).filter((l) =>
        /Recovery attempt|welcome_request|→ re-add|-> re-add/.test(l)
      );

      const ok =
        both.count === 2 &&
        afterRemoval.count === 1 &&
        peerReadBefore &&
        peerStillHasBefore &&
        !peerGotAfter &&
        evictLine !== null &&
        cameBack.length === 0;
      await recordObserved(
        'GRP-3',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          rosterBeforeRemoval: both.count,
          rosterAfterRemoval: afterRemoval.count,
          peerReadBeforeRemoval: peerReadBefore,
          peerStillHoldsPreRemovalMessage: peerStillHasBefore,
          peerReceivedPostRemovalMessage: peerGotAfter,
          removedDeviceLearntFromTheCommit: evictLine !== null,
          // false means the removed device never selected the conversation on this run, NOT that
          // the guard failed - the 403's absence is then unproven rather than disproven.
          rosterRequestSuppressed: rosterGuard,
          // The LINES, not a count: a failure here has to name what the client asked for, or the
          // row says only that something happened and the log has to be opened to find out what.
          removedDeviceAskedToComeBack: cameBack.slice(0, 4),
          negativeWindowMs: NEGATIVE_WINDOW_MS,
        },
        { W1: o1, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-4 - the invitation LINK: generate it on W1, open it on the other account.
 *
 * The panel's own description states the delivery condition ("des qu'un membre est en ligne"), so W1
 * stays connected throughout and the check is about the link rather than about a queue. The URL
 * shape is asserted before it is used - a check that navigates to whatever the input held would
 * report a product failure for a harness that read the wrong field.
 *
 * THE TOKEN IS NEVER RECORDED. It is a join capability for a real group on production and this
 * repository is public: the row carries the path shape and the token's LENGTH, never its value.
 */
async function grp4() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withGroup(w1, 4, async (name) => {
      await openGroupSettings(w1);
      await realClick(w1, 'text=Générer un lien');
      await until(w1, `/\\/g\\/join\\//.test(document.body.innerHTML)`, 20000).catch(() => {});
      await sleep(1500);
      const share = JSON.parse(await evaluate(w1, SHARE));
      await closeOverlays(w1);

      const url = share.value;
      const shapeOk =
        typeof url === 'string' && /^https:\/\/canari-emse\.fr\/g\/join\/[A-Za-z0-9_-]{8,}$/.test(url);

      let invitationNamesGroup = null;
      let joinedMs = null;
      let rosterAfterJoin = null;
      if (shapeOk) {
        await goto(w2, url.replace('https://canari-emse.fr', ''));
        // THE LINK OPENS AN INVITATION, IT DOES NOT JOIN. The page reads "Vous avez ete invite(e) a
        // rejoindre le groupe <name>" and offers `Rejoindre le groupe` / `Annuler`; navigating and
        // waiting - which is what this check did on its first run - measures a page, not a join.
        await until(w2, `/Rejoindre le groupe/.test(document.body.innerText)`, 20000);
        invitationNamesGroup = await evaluate(
          w2,
          `document.body.innerText.indexOf(${JSON.stringify(name)}) !== -1`
        );
        const t0 = Date.now();
        await realClick(w2, 'text=Rejoindre le groupe');
        await ensureChat(w2);
        joinedMs = (await awaitListed(w2, name, 60000)) === null ? null : Date.now() - t0;
        await openGroup(w1, name, { navigate: false, label: 'grp4-w1' });
        rosterAfterJoin = (await panelOf(w1)).count;
        await closeOverlays(w1);
      }

      const ok = shapeOk && invitationNamesGroup === true && joinedMs !== null && rosterAfterJoin === 2;
      await recordObserved(
        'GRP-4',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          linkOffered: share.offersGenerate || share.offersRegenerate,
          linkGenerationError: share.error,
          urlShapeOk: shapeOk,
          tokenLength: shapeOk ? url.split('/').pop().length : null, // length only, never the token
          invitationPageNamesGroup: invitationNamesGroup,
          joinedAfterClickMs: joinedMs,
          rosterAfterJoin,
          redactionNote:
            'the join token is a capability for a real group on production and is never recorded.',
        },
        { W1: o1, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/** GRP-5 - rename a group, seen on the other side. A rename is a broadcast, not a local label. */
async function grp5() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    const name = mark('GRP5');
    const renamed = `${name}-R`;
    await closeOverlays(w1);
    await createGroup(w1, name, { label: 'grp5' });
    await openGroup(w1, name, { navigate: false, label: 'grp5' });
    try {
      await addPeer(w1);
      await closeOverlays(w1);
      await awaitListed(w2, name);

      await openGroup(w1, name, { navigate: false, label: 'grp5' });
      await openGroupSettings(w1);
      await renameGroup(w1, renamed);

      const creatorShows = await lists(w1, renamed);
      const peerMs = await awaitListed(w2, renamed);

      const ok = creatorShows === true && peerMs !== null;
      await recordObserved(
        'GRP-5',
        ok ? 'PASS' : 'FAIL',
        { from: name, to: renamed, creatorShowsNewName: creatorShows, peerSawNewNameMs: peerMs },
        { W1: o1, W2: o2 }
      );
      return ok;
    } finally {
      // BOTH NAMES, because the teardown cannot know whether the rename landed - and a group left
      // behind under either one is debris `cleanup.mjs` would have to sweep by hand.
      await closeOverlays(w1).catch(() => {});
      await deleteGroup(w1, renamed).catch(() => {});
      await deleteGroup(w1, name).catch(() => {});
    }
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-6 - leaving, which deliberately commits nothing.
 *
 * The guarantee is SERVER-SIDE and the docstring says so, so the check asserts what a server
 * decision actually produces: the leaver stops listing the group, and a message sent after the
 * departure does not reach them. It asserts NOTHING about the ratchet tree - the leaf is documented
 * to remain until the next commit, and a check claiming otherwise would assert the opposite of the
 * design. The remaining member's roster is recorded as evidence for exactly that reason.
 */
async function grp6() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withGroup(w1, 6, async (name) => {
      await addPeer(w1);
      await closeOverlays(w1);
      await awaitListed(w2, name);
      await openGroup(w2, name, { navigate: false, label: 'grp6-w2' });

      const before = mark('GRPLB');
      await openGroup(w1, name, { navigate: false, label: 'grp6-w1' });
      await send(w1, before);
      const leaverReadBefore = await awaitMessage(w2, before, 30000).then(
        () => true,
        () => false
      );

      await openGroupSettings(w2);
      await leaveGroup(w2, name);
      const leaverStillLists = await lists(w2, name);

      const after = mark('GRPLA');
      await openGroup(w1, name, { navigate: false, label: 'grp6-w1' });
      await send(w1, after);
      await sleep(NEGATIVE_WINDOW_MS);
      const leaverGotAfter = Number(await countMessage(w2, after)) > 0;

      await openGroupSettings(w1);
      const roster = await panelOf(w1);
      await closeOverlays(w1);

      const ok = leaverReadBefore && leaverStillLists === false && !leaverGotAfter;
      await recordObserved(
        'GRP-6',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          leaverReadBeforeLeaving: leaverReadBefore,
          leaverStillListsGroup: leaverStillLists,
          leaverReceivedPostDepartureMessage: leaverGotAfter,
          rosterOnRemainingMember: roster.count, // EVIDENCE: a leave issues no Remove commit
          negativeWindowMs: NEGATIVE_WINDOW_MS,
        },
        { W1: o1, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-7 - add a member who is OFFLINE; they join on their next connection.
 *
 * `cutHard`, not `cut`: the invitee is a RECEIVER here, and a Welcome arrives down the socket that
 * `emulateNetworkConditions` leaves open. `net.mjs` documents the measurement that settled it - a
 * client "taken offline" kept its gateway presence refreshing for sixty seconds.
 */
async function grp7() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    const armed = await armCut(w2);
    await ensureChat(w2);
    return await withGroup(w1, 7, async (name) => {
      const cut = await cutHard(w2);
      try {
        await addPeer(w1);
        await closeOverlays(w1);
        const marker = mark('GRPOFF');
        await openGroup(w1, name, { navigate: false, label: 'grp7' });
        await send(w1, marker);
        await sleep(5000);
        const sawWhileOffline = await lists(w2, name);

        await cut.restore();
        const joinedMs = await awaitListed(w2, name, 90000);
        let readMs = null;
        if (joinedMs !== null) {
          const t0 = Date.now();
          await openGroup(w2, name, { navigate: false, label: 'grp7-w2' });
          readMs = await awaitMessage(w2, marker, 60000).then(
            () => Date.now() - t0,
            () => null
          );
        }

        const ok = sawWhileOffline === false && joinedMs !== null && readMs !== null;
        // W2 IS THE CLIENT THIS CHECK CUT, so its disconnection noise is the instrument and not a
        // finding: `ERR_INTERNET_DISCONNECTED`, the presence fetches that failed, the socket closing
        // and every reconnect attempt after it. W1 was never touched and is judged raw. `severe` is
        // not forgiven on either side - a lost frame is a lost frame whatever the link did.
        await recordObserved(
          'GRP-7',
          ok ? 'PASS' : 'FAIL',
          {
            group: name,
            socketsClosed: cut.socketsClosed,
            gatewayBackAfterArmMs: armed.gatewayBackAfterMs,
            listedWhileOffline: sawWhileOffline,
            joinedAfterReconnectMs: joinedMs,
            readPreJoinMessageMs: readMs,
          },
          { W1: await report(o1), W2: ignoringOfflineCut(await report(o2)) }
        );
        return ok;
      } finally {
        await cut.restore().catch(() => {});
      }
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-8 - add and remove the same member twice in a row, fast.
 *
 * FOUR COMMITS WITH NO SETTLING TIME BETWEEN THEM, which is the only way to reach the states an
 * unhurried sequence hides: a Welcome for an epoch already superseded, a second Add against a leaf
 * the first Remove has not finished retiring. Each gesture still waits on its own post-condition - a
 * roster count that moved - so this is fast without being a race the harness invented.
 */
async function grp8() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  const [w2, o2] = await observed(W2, 'GRP-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withGroup(w1, 8, async (name) => {
      const ownerIds = (await panelOf(w1)).removableIds;
      const rounds = [];
      for (let i = 1; i <= 2; i++) {
        await closeOverlays(w1);
        await openGroup(w1, name, { navigate: false, label: 'grp8' });
        await addPeer(w1);
        const added = await panelOf(w1);
        const peerId = added.removableIds.find((id) => !ownerIds.includes(id)) ?? null;
        if (!peerId) throw new Error(`grp8: round ${i} could not identify the peer after the add`);
        await removeMember(w1, peerId);
        const removed = await panelOf(w1);
        rounds.push({ round: i, afterAdd: added.count, afterRemove: removed.count });
        await closeOverlays(w1);
      }

      // THE END STATE IS WHAT MATTERS, and it is asserted on BOTH sides: W1's roster is back to one,
      // and a message sent now must not reach an account that is no longer a member.
      const marker = mark('GRPCHURN');
      await openGroup(w1, name, { navigate: false, label: 'grp8' });
      await send(w1, marker);
      await sleep(NEGATIVE_WINDOW_MS);
      const peerGot = Number(await countMessage(w2, marker)) > 0;
      const final = await panelOf(w1);
      await closeOverlays(w1);

      const ok =
        rounds.every((r) => r.afterAdd === 2 && r.afterRemove === 1) && final.count === 1 && !peerGot;
      await recordObserved(
        'GRP-8',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          rounds,
          finalRoster: final.count,
          removedAccountReceivedFinalMessage: peerGot,
          negativeWindowMs: NEGATIVE_WINDOW_MS,
        },
        { W1: o1, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * GRP-9 - a member row must render a display NAME, never a raw user id.
 *
 * Observed once, never reproduced, and the row exists so that "not seen lately" is a measurement
 * rather than a memory. A raw id in a member row means the profile lookup failed and the component
 * fell back to the key it had - the same shape as a mention rendering `@[uuid]`.
 *
 * THE REMOVE CONTROL IS A SEPARATE FINDING and is recorded, not asserted. Its accessible name is
 * `Retirer <64 hex characters>`, so a screen reader announces an OIDC subject id where a person's
 * name belongs. That is a real defect in the same panel, but it is not what this row asks, and
 * folding it in would make a check fail for a reason its own title does not name.
 */
async function grp9() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  try {
    await ensureChat(w1);
    return await withGroup(w1, 9, async (name) => {
      await addPeer(w1);
      const p = await panelOf(w1);
      await closeOverlays(w1);

      const RAW_ID =
        /^[0-9a-f]{32,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const rowsThatAreIds = p.rows.filter((r) => RAW_ID.test(r.trim()));
      const namesPresent =
        p.rows.some((r) => r.includes(OWNER_NAME.split(' ')[0])) &&
        p.rows.some((r) => r.includes(PEER_NAME.split(' ')[0]));

      const ok = p.count === 2 && rowsThatAreIds.length === 0 && namesPresent;
      await recordObserved(
        'GRP-9',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          roster: p.count,
          rowCount: p.rows.length,
          rowsRenderingARawId: rowsThatAreIds.length,
          bothDisplayNamesPresent: namesPresent,
          // FINDING, not an assertion - see the note above.
          removeControlAccessibleNameIsARawId: p.removableIds.every((id) => /^[0-9a-f]{64}$/.test(id)),
          removeControlIdLength: p.removableIds[0]?.length ?? null,
        },
        { W1: o1 }
      );
      return ok;
    });
  } finally {
    w1.close();
  }
}

/**
 * GRP-10 - the invitation link of one group must not appear in another group's panel.
 *
 * FOUND BY READING `ChatGroupPanel.svelte` WHILE WRITING GRP-4, and armed rather than fixed first,
 * for the reason SEARCH-2 was: a check is worth more against the code as it shipped. The panel's
 * reset effect runs on open and clears `renameInput`, `confirmDelete` and `confirmLeave` - and not
 * `shareLink`, `shareCopied` or `shareError`. So after generating a link for group A, opening group
 * B's panel in the same page session shows B's name above A's join URL, with "Regenerer" and "Lien
 * copie" beside it.
 *
 * WHY IT IS NOT MERELY COSMETIC: the URL is a capability to join group A. A user who copies what B's
 * panel shows distributes access to A, to an audience chosen for B, while the interface states that
 * the link was copied. Nothing escalates on the server; the wrong people are handed the wrong door,
 * by a screen that named the right one.
 */
async function grp10() {
  const [w1, o1] = await observed(W1, 'GRP-W1');
  try {
    await ensureChat(w1);
    const a = mark('GRP10');
    const b = mark('GRP10');
    await closeOverlays(w1);
    await createGroup(w1, a, { label: 'grp10-a' });
    await createGroup(w1, b, { label: 'grp10-b' });
    try {
      await openGroup(w1, a, { navigate: false, label: 'grp10-a' });
      await openGroupSettings(w1);
      await realClick(w1, 'text=Générer un lien');
      await sleep(4000);
      const onA = JSON.parse(await evaluate(w1, SHARE));
      await closeOverlays(w1);

      // NO RELOAD BETWEEN THEM, on purpose: the subject is component state within one page session,
      // which is exactly what a user does when they switch conversations.
      await openGroup(w1, b, { navigate: false, label: 'grp10-b' });
      await openGroupSettings(w1);
      await sleep(1500);
      const onB = JSON.parse(await evaluate(w1, SHARE));
      await closeOverlays(w1);

      const leaked = onB.value !== null && onB.value === onA.value;
      const ok = !leaked && onB.value === null && onB.offersGenerate === true && onB.saysCopied === false;
      await recordObserved(
        'GRP-10',
        ok ? 'PASS' : 'FAIL',
        {
          groupA: a,
          groupB: b,
          linkGeneratedOnA: onA.value !== null,
          secondPanelShowsALink: onB.value !== null,
          secondPanelShowsTheOtherGroupsLink: leaked,
          secondPanelOffersGenerate: onB.offersGenerate,
          secondPanelOffersRegenerate: onB.offersRegenerate,
          secondPanelSaysCopied: onB.saysCopied,
          redactionNote: 'link values are compared, never recorded - a join token is a capability.',
        },
        { W1: o1 }
      );
      return ok;
    } finally {
      await closeOverlays(w1).catch(() => {});
      await deleteGroup(w1, a).catch(() => {});
      await deleteGroup(w1, b).catch(() => {});
    }
  } finally {
    w1.close();
  }
}

const CHECKS = {
  1: grp1,
  2: grp2,
  3: grp3,
  4: grp4,
  5: grp5,
  6: grp6,
  7: grp7,
  8: grp8,
  9: grp9,
  10: grp10,
};

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`GRP-${n}`, 'ERROR', { error: e.message });
    results.push([n, false]);
  }
}
console.log(`\nGRP: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE FROM THESE BOOLEANS - `results.mjs` derives it from the recorded verdicts, which are
// the gated ones. The note at the foot of `search.mjs` and `mention.mjs` explains why a boolean a
// check returns is not its verdict.
