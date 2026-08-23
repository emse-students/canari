/**
 * Opening a GROUP conversation by name, and proving the right one opened.
 *
 * `openConversation` in `chat.mjs` cannot do this, and the reason is a harness fault found by
 * HEAL-W2's first run. It selects the shortest element whose text contains the name - correct - and
 * then clicks `text=<first LINE of that element>`. The first line of a group row is the one-letter
 * AVATAR, so asking for `HGRPktp5w` clicks `text=H`, which matches EVERY group whose name starts
 * with H. The run opened a different group and would have measured it, silently.
 *
 * One module rather than a copy in each check, because the failure it prevents is precisely two
 * call sites disagreeing about which conversation is on screen.
 */
import { evaluate, goto, PANE_HAS_CONVERSATION, realClick, until } from './chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPOSER = '.chat-composer-footer .chat-composer-editor';

/**
 * THE COMPOSER IS NOT THE ONLY WAY A CONVERSATION CAN BE OPEN, and assuming it was cost READ-10 its
 * verdict and would have cost every DEL row after it.
 *
 * A conversation the peer deleted is kept, marked `removed`, and `ChatArea.svelte` renders it with
 * the composer REPLACED by a notice and a "Supprimer localement" button. So `openGroup` waited 12 s,
 * three times, for a control the product deliberately does not draw in the state under test - and
 * then threw "would not open", which reads as a product defect and is not one. Measured directly:
 * clicking the row DOES open it, notice and button present, composer absent by design.
 *
 * So the post-condition is "the pane is showing a conversation", satisfied either way, and
 * `paneIs(name)` still decides whether it is the RIGHT one.
 */
// SHARED WITH `chat.mjs`, WHICH IS WHERE THE PANE PRIMITIVES LIVE. This file had its own copy, and
// so did `openConversation` and `read.leaveConversation` - three copies of a predicate two of which
// were wrong, one of them inverted. `PANE_HAS_CONVERSATION` is that predicate, once.
const OPENED = PANE_HAS_CONVERSATION;

/** A real mouse click at a point - `element.click()` is not what these components listen for. */
export async function clickAt(cx, x, y) {
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cx.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
}

/**
 * A POINT PROVEN TO BE ON THE ROW - scrolled into view, settled, and hit-tested.
 *
 * `getBoundingClientRect()` describes where an element is in the LAYOUT, and says nothing about
 * whether that place is on screen. A sidebar with a dozen conversations puts a freshly created group
 * below the fold, so the rect came back with `y = 953` on an 800-pixel viewport and the click went
 * into nothing: no error, no navigation, and `openGroup` then reported three failed attempts on a
 * row it had located perfectly. Measured 2026-08-23 while GRP was being written - GRP-7 and GRP-10
 * both died on it, and the diagnosis was `document.elementFromPoint(224, 953) === null`.
 *
 * So three things the old version did none of:
 *   - **scroll the row into view**, because a row nobody can see is a row nobody can click;
 *   - **settle the rect**, two identical reads in a row, which a list still scrolling cannot produce;
 *   - **hit-test the point**, because "the row is here" and "something else is here" are the two
 *     states a coordinate cannot distinguish on its own.
 *
 * The same trap is documented for the mention chip in `mention.mjs`, where an unsettled point made
 * MENTION-1 fail intermittently with every other field correct. It is the same fault twice, so this
 * one is written where every conversation-opening call site gets it.
 */
const ROW_POINT = (name) => String.raw`(async function () {
  var want = ` + JSON.stringify(name) + String.raw`;
  var find = function () {
    var els = [].slice.call(document.querySelectorAll('button, [role=button], a, li'));
    var hits = els.filter(function (e) {
      return (e.innerText || '').indexOf(want) !== -1 && e.getBoundingClientRect().width > 0;
    });
    hits.sort(function (a, b) { return a.innerText.length - b.innerText.length; });
    return hits[0] || null;
  };
  var el = find();
  if (!el) return JSON.stringify(null);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  var last = null, settled = false, onTarget = false, hit = null, point = null;
  for (var i = 0; i < 40; i++) {
    el = find() || el;
    var r = el.getBoundingClientRect();
    var p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    if (last && last.x === p.x && last.y === p.y) {
      settled = true;
      point = p;
      var at = document.elementFromPoint(p.x, p.y);
      hit = at ? (at.tagName + '.' + String(at.className || '').split(' ')[0]) : null;
      onTarget = !!at && (at === el || el.contains(at));
      if (onTarget) break;
    }
    last = p;
    await new Promise(function (res) { setTimeout(res, 100); });
  }
  var q = point || last;
  return JSON.stringify({
    x: q.x, y: q.y, settled: settled, onTarget: onTarget, hit: hit,
    text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50)
  });
})()`;

/**
 * Opens the conversation whose sidebar row CONTAINS `name`, then asserts the pane shows it.
 *
 * The post-condition is the point: a click that lands on the wrong row is exactly the failure being
 * guarded against, and nothing else in a run can detect it - every later assertion would simply be
 * measuring a different conversation and reporting it as this one.
 */
export async function openGroup(cx, name, { navigate = false, label = 'client' } = {}) {
  if (navigate) await goto(cx, '/chat');

  await until(cx, `${ROW_POINT(name)} !== null`, 25000);

  // RE-LOCATE ON EVERY ATTEMPT, because the coordinates go stale under a live list.
  //
  // The conversation list re-sorts as messages and group events arrive, so a rect read once and
  // clicked a moment later can land on a neighbouring row or on nothing at all - which presents as
  // a composer that never appears, i.e. as the app failing to open a conversation that is plainly
  // there. Same reasoning as `stableCentreOf` in `cdp.mjs`; three attempts, then let it throw,
  // because a row that will not open after three re-locations is a finding rather than noise.
  let row = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    row = JSON.parse(await evaluate(cx, ROW_POINT(name)));
    if (!row) throw new Error(`${label}: no sidebar row for ${name}`);
    if (!row.onTarget) {
      // THE POINT IS NOT ON THE ROW, so clicking it would report on whatever is. Say which of the
      // two it is - a rect that never settled is a list still moving, a settled rect that resolves
      // to something else is a cover.
      console.log(
        `[groupnav] ${label}: attempt ${attempt} could not aim at ${name}` +
          ` (settled=${row.settled}, hit=${JSON.stringify(row.hit)})`
      );
      await sleep(1500);
      continue;
    }

    await clickAt(cx, row.x, row.y);
    const opened = await until(cx, OPENED, 12000).catch(() => null);
    if (opened !== null) {
      await sleep(2500);
      if (await paneIs(cx, name)) return row.text;
    }
    console.log(`[groupnav] ${label}: attempt ${attempt} did not open ${name} (clicked ${JSON.stringify(row.text)})`);
    await sleep(2000);
  }
  throw new Error(`${label}: ${name} would not open after 3 attempts (last row ${JSON.stringify(row?.text)})`);
}

/** True when the OPEN conversation's pane names `name`. The group title is inside the pane. */
export function paneIs(cx, name) {
  return evaluate(
    cx,
    `(function () {
      var want = ${JSON.stringify(name)};
      var c = document.querySelector('${COMPOSER}');
      if (c) return (c.closest('section').innerText || '').indexOf(want) !== -1;
      // NO COMPOSER: a conversation the peer deleted draws the "Supprimer localement" control in its
      // place, and that control's own section is the pane. Falling back to the whole document would
      // match the SIDEBAR row for the same conversation and call any list a pane.
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
        return (x.innerText || '').indexOf('Supprimer localement') !== -1;
      })[0];
      if (!b) return false;
      var sec = b.closest('section') || b.parentElement;
      return !!sec && (sec.innerText || '').indexOf(want) !== -1;
    })()`
  );
}

/**
 * Which modal or panel is on screen, by the one control each of them alone carries.
 *
 * ESCAPE DOES NOT CLOSE THE NEW-CONVERSATION MODAL, which is worth stating rather than working
 * around: a check that assumed it did left the dialog up, and every later click then failed with
 * `no stable element` for a control plainly in the DOM. Each overlay ships its own button, so each
 * is closed by its own button.
 */
export function overlayOn(cx) {
  return evaluate(
    cx,
    `(function () {
      var t = document.body.innerText;
      if (document.querySelector('#new-group-name')) return 'new-conversation';
      if (/Nouvelle discussion Contact Groupe/.test(t.replace(/\s+/g, ' '))) return 'new-conversation';
      if (/Envoyer l'invitation/.test(t)) return 'add-member';
      if (/Quitter le groupe/.test(t)) return 'group-panel';
      return 'none';
    })()`
  );
}

/** Closes whatever overlay is open, by that overlay's own control, and proves the screen is clear. */
export async function closeOverlays(cx) {
  for (let i = 0; i < 4; i++) {
    const state = await overlayOn(cx);
    if (state === 'none') return i === 0 ? 'already clear' : 'closed';
    await realClick(
      cx,
      state === 'group-panel' ? 'text=Fermer les paramètres du groupe' : 'text=Fermer'
    ).catch(() => {});
    await sleep(1200);
  }
  throw new Error(`could not close the overlay, still on ${await overlayOn(cx)}`);
}

/**
 * Creates a group conversation by name and returns once the SIDEBAR names it.
 *
 * ONE GESTURE, FOUR CALL SITES, AND THEY DID NOT AGREE. `newgroup.mjs`, `del1.mjs` and READ-10 each
 * hand-rolled this, and each was missing something a sibling had learnt:
 *
 *   - **READ-10 waited for `#new-group-name` BEFORE clicking the "Groupe" tab.** That input lives
 *     inside the tab's own `{:else if activeTab === 'group'}` branch, so it cannot exist until after
 *     the click - the check waited ten seconds for something its next line was going to create, and
 *     died there every time. It is why READ-10 had never produced a verdict.
 *   - **`del1.mjs` clicked "Créer le groupe" without checking it was enabled.** The button is
 *     disabled until the name lands, and a click on a disabled control is discarded in SILENCE -
 *     the same race `send` documents for the composer.
 *   - **Only `newgroup.mjs` waited for the right post-condition.** Creating a group sometimes leaves
 *     it open and sometimes does not: with several conversations in the list the sidebar re-sorts and
 *     the selection is lost, so waiting for the composer fails on a group that was created
 *     perfectly. The sidebar row is what "the group exists" actually implies.
 *
 * Three lessons that each cost a run, held in three different files, none of which had all three.
 * The caller decides whether to open it.
 *
 * @param cx a connected client
 * @param name the group's name - unique per run, so the sidebar wait cannot match a previous one
 * @param label who is asking, for the error message
 */
export async function createGroup(cx, name, { label = 'createGroup' } = {}) {
  // A modal left open by an earlier step HIDES the trigger, and presents as "no stable element" for
  // a control that is plainly in the DOM. Always start from a clear screen.
  await closeOverlays(cx);
  if ((await evaluate(cx, 'location.pathname')) !== '/chat') await goto(cx, '/chat');

  await realClick(cx, '[aria-label="Nouvelle discussion"]');
  // THE MODAL, not the group input: the modal opens on the "Contact" tab and the group input does
  // not exist yet. This is the ordering READ-10 had inverted.
  await until(cx, `/Nouvelle discussion/.test(document.body.innerText)`, 10000);
  await realClick(cx, 'text=Groupe');
  await until(cx, `!!document.querySelector('#new-group-name')`, 10000);

  await realClick(cx, '#new-group-name');
  await cx.send('Input.insertText', { text: name });

  // POST-CONDITION BEFORE THE CLICK, not a sleep: the submit is disabled until the name lands.
  await until(
    cx,
    `(function () {
       var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
         return /Créer le groupe/.test(x.innerText || '');
       })[0];
       return !!b && !b.disabled;
     })()`,
    8000
  );
  await realClick(cx, 'text=Créer le groupe');

  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) !== -1`, 25000);
  await sleep(2500);
  return name;
}

/**
 * Dismisses the OPEN conversation that the peer deleted, through the control the product offers for
 * it, and returns once the sidebar has stopped naming it.
 *
 * WHY A CHECK OWES THIS. A conversation marked `removed` is a fact about what its owner was TOLD, so
 * it survives every later reconciliation until they delete it by hand - `decideAbsentGroupFate`'s
 * first guard, which no server state can reach past. That is right for a person and wrong for a rig:
 * READ-10 created one per run and left it, so four dead `READ10-*` rows sat in W1's profile emitting
 * a `[DISCOVERY] ... kept` line each on every load of every later check. Debris that ACCUMULATES and
 * talks is the worst kind - it trains its reader to skip the lines the next defect will hide in.
 *
 * It is also coverage rather than housekeeping: this is the only exit the product gives that row, so
 * a check that cleans up after itself is a check that proves the button works.
 *
 * NO CONFIRMATION STEP, deliberately unguarded: `handleDeleteGroupLocally` purges on the click, with
 * no dialog and no server call. A tolerant `.catch()` for a confirm that does not exist would be a
 * fallback hiding the day one appears.
 *
 * @param cx a connected client, with the dead conversation ALREADY OPEN
 * @param name the conversation's name, which the sidebar must stop showing
 */
export async function dismissLocally(cx, name) {
  await realClick(cx, 'text=Supprimer localement');
  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) === -1`, 20000);
  await sleep(1500);
}

/**
 * Deletes the group named `name` through the product, from a client that may delete it.
 *
 * The gesture is settings -> "Supprimer le groupe" -> confirm, and it was written out inline in
 * READ-10 while `cleanup.mjs` was about to need the same six lines for its group sweep. One copy,
 * for the reason `createGroup` and `addMember` exist: the three post-conditions here are the whole
 * correctness of it, and a second copy would be missing one of them within a week.
 *
 * @returns `'deleted'`, or `'not listed'` when the group is not on this client at all - which is the
 *   ANSWER for a teardown asking "is it gone", and never an error.
 */
export async function deleteGroup(cx, name) {
  await closeOverlays(cx);
  if ((await evaluate(cx, 'location.pathname')) !== '/chat') await goto(cx, '/chat');
  const listed = await evaluate(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) !== -1`);
  if (listed !== true && listed !== 'true') return 'not listed';

  await openGroup(cx, name, { navigate: false, label: 'deleteGroup' });
  await realClick(cx, '[aria-label="Paramètres du groupe"]');
  await until(cx, `/Supprimer le groupe/.test(document.body.innerText)`, 10000);
  await sleep(1000);
  await realClick(cx, 'text=Supprimer le groupe');
  await sleep(1500);
  // The confirmation is a second dialog on some layouts and a direct action on others, so a missing
  // "Supprimer" is not a failure - the post-condition below is what decides.
  await realClick(cx, 'text=Supprimer').catch(() => {});
  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) === -1`, 30000);
  await sleep(3000);
  return 'deleted';
}
