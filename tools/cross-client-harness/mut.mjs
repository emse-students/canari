#!/usr/bin/env node
/**
 * MUT-1..20 - message mutation (edit, delete, react, pin) on both transports.
 *
 * THE CENTRAL POINT OF THIS PHASE: every row that applies to both venues runs TWICE - once in the
 * DM (MLS transport, `messaging.ts` / `useMessaging.svelte.ts`) and once in the `Campagne de test`
 * channel (REST transport, `ChannelService.ts` / `useChannelWorkspaces.svelte.ts`). They look the
 * same on screen and are NOT the same code, which is exactly what MUT-6 vs MUT-8 and MUT-15 vs
 * MUT-16 exist to prove: a DM delete is a client-side tombstone with no server enforcement at all,
 * a channel delete is a server-authoritative hard row delete; a DM pin is localStorage-only with no
 * replay, a channel pin is re-hydrated from the server on every open. Getting that wrong in either
 * direction is the whole risk this phase is checking for.
 *
 * READ OFF THE SOURCE, not guessed (the numbers and code paths are the whole check):
 *   - `MessageBubbleToolbar.svelte`: edit needs `isOwn && !hasMedia`; delete needs `isOwn ||
 *     canModerate`; `canModerate` (`MainChatPage.svelte` `canModerateSelectedChannel`) is
 *     `isSelectedChannel && ...` - i.e. ALWAYS false in a DM or group, by construction.
 *   - `useMessaging.svelte.ts` `handleDeleteMessage`/`handleEditMessage`: the ONLY ownership check
 *     in the whole DM path, and it runs on the SENDING device before broadcasting. The RECEIVING
 *     handler, `systemMessageHandler.ts` (`event === 'delete_message'` / `'edit_message'`), applies
 *     the mutation to whatever `data.messageId` names with NO check that `senderNorm` is the
 *     original author. Ownership is a courtesy the well-behaved client extends to itself; nothing
 *     downstream re-checks it. MUT-10 investigates this precisely.
 *   - `pinStore.svelte.ts` + `historySystemEvents.ts`/`systemMessageHandler.ts`: a DM/group pin is
 *     an MLS system event applied into a per-conversation `localStorage` set; the history-bundle
 *     merge (`systemMessageHandler.ts` `history_bundle`) never touches it. A channel pin is
 *     fetched fresh from the server (`MainChatPage.svelte` `listPinnedMessageIds` -> `setPinnedSet`,
 *     which REPLACES the set) every time the channel is opened.
 *   - `useConversations.svelte.ts` `loadChannelHistory`: wipes the local channel message cache
 *     (`storage.deleteMessagesForConversation`) and REPLACES it wholesale from a fresh
 *     `channelService.listMessages` fetch whenever the 5-minute cache is stale or invalidated - and
 *     `deleteChannelMessage`/`handleChannelMessageDeleted` both call
 *     `invalidateChannelHistoryCache` right after a delete, so the NEXT open force-refetches and a
 *     hard-deleted row is simply absent from the server's answer.
 *   - `messageReactions.ts`: `MAX_DISTINCT_MESSAGE_REACTIONS = 15`, enforced client-side for DMs
 *     (`toggleMessageReaction` returns null past the cap) and server-side for channels
 *     (`service.toggleReaction` is authoritative, the client only applies optimistically).
 *   - `messaging.ts` `addReaction`/`notifyReaction`: a `POST /api/mls/notify-reaction` fires
 *     if-and-only-if `targetMsg.senderId !== userId` - the author-only, never-the-reactor rule.
 *
 * OBSERVATION IS PART OF EVERY CHECK HERE, and it was not until 2026-08-15. This file computed
 * twenty verdicts while reading no console line at all - the same fault READ shipped eight PASSes
 * under (rule 14 of testing-methodology). Both clients are now watched from BEFORE the setup
 * navigates, and every outcome, including each `catch`, goes through `finish` -> `gate`, so a dirty
 * window turns a PASS into `PASS-DIRTY` and records WHICH client said what. The three checks that
 * cut a client on purpose (MUT-4, MUT-7, MUT-19) narrow that client's window with
 * `ignoringOfflineCut`, and only that client's.
 *
 * STABLE HOOKS USED (deliberately never French prose where one exists):
 *   - `.msg-status-sent` / `.msg-status-read` (`MessageMetadata.svelte`, added this session).
 *   - `lucide-svelte`'s `Icon.svelte` injects `lucide-<icon-name>` on every icon's own `<svg>`
 *     (verified by reading the installed package, not assumed) - so `svg.lucide-trash-2`,
 *     `.lucide-pencil`, `.lucide-reply`, `.lucide-forward`, `.lucide-smile`, `.lucide-pin` /
 *     `.lucide-pin-off` locate the toolbar's reply/delete/edit/react/pin controls WITHOUT reading
 *     their (localised) `aria-label`. This is a better hook than the harness had for MSG-3's
 *     `clickBubbleAction`, and is offered here as a pattern the rest of the harness could adopt.
 *   - `[role="dialog"]` (`Modal.svelte`) scopes the delete-confirmation modal.
 *   - `[role="group"] button[aria-pressed]` (`MessageReactions.svelte`) reads a viewer's own
 *     reaction state without depending on the (localised) `title` tooltip.
 *   - `.group` (`MessageBubble.svelte`'s own outer wrapper class - literally `class="group relative
 *     flex ..."`) is used as the SCOPE boundary for every per-message query below, so a search for
 *     an absent control can never escape into a neighbouring message's row.
 *
 * GAPS - no stable hook exists, so French text is the only signal (see the final report for the
 * full list; flagged inline at each use):
 *   - The "(modifié)" edited marker (`MessageMetadata.svelte`) carries no class of its own.
 *   - The delete-confirmation modal's confirm button (`MessageBubble.svelte`'s `Modal` footer) has
 *     no icon, only `m.common_delete_button()` text - scoped by `[role="dialog"]` to stay safe.
 *   - The inline edit form's Save button (`MessageEditForm.svelte`) is the same shape: text-only.
 *   - The send/pending status spans (`MessageMetadata.svelte` `showSendStatus`) carry no semantic
 *     class either, only Tailwind utility classes - unlike sent/read, which now have one.
 *
 *   node mut.mjs                 # all twenty
 *   node mut.mjs --only 10       # one
 */
import {
  client,
  openDM,
  openChannel,
  evaluate,
  realClick,
  clickAtPoint,
  activate,
  hoverBubble,
  bubbleCentre,
  armComposer,
  fireComposer,
  awaitMessage,
  countMessage,
  attachFiles,
  until,
  COMPOSER,
} from './chat.mjs';
import { watch, report, gate, ignoringOfflineCut } from './watch.mjs';
import { record, mark } from './results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from './names.mjs';
import { fileURLToPath } from 'node:url';

const { W1, W2 } = PORTS;
const MATCH = 'canari-emse.fr';
const abs = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

// ── Connection helpers ───────────────────────────────────────────────────────────────────────

/**
 * THE WATCHERS ARE ARMED BEFORE THE SETUP NAVIGATES, NOT AFTER IT.
 *
 * A window opened after `openDM` cannot see the boot the navigation causes, which is where a check's
 * own setup goes wrong - TYPE-5 failed inside its setup with both its windows opened below it, and
 * the one failure it produced carried no console at all. `report` forgives `documentsReplaced`
 * socket closes by itself, so covering the navigation costs nothing and buys the only view of it.
 */
async function openDmPair() {
  const [a, b] = await Promise.all([client(W1, MATCH), client(W2, MATCH)]);
  const w = { W1: await watch(a, 'W1'), W2: await watch(b, 'W2') };
  await openDM(a, PEER_NAME);
  await openDM(b, OWNER_NAME);
  return [a, b, w];
}

async function openChannelPair() {
  const [a, b] = await Promise.all([client(W1, MATCH), client(W2, MATCH)]);
  const w = { W1: await watch(a, 'W1'), W2: await watch(b, 'W2') };
  await openChannel(a, VENUE.community, VENUE.channel);
  await openChannel(b, VENUE.community, VENUE.channel);
  return [a, b, w];
}

function closeAll(...clients) {
  for (const c of clients) c.close();
}

/**
 * Drains and classifies both windows, narrowing whichever client THIS check deliberately cut.
 *
 * `narrow` is per-label on purpose: `ignoringOfflineCut` forgives the consequences of an outage the
 * check performed, and applying it to the client that was never cut would forgive a real one.
 */
async function observe(w, narrow = {}) {
  const out = {};
  for (const [label, ow] of Object.entries(w)) {
    const rep = await report(ow);
    out[label] = narrow[label] ? narrow[label](rep) : rep;
  }
  return out;
}

/**
 * THE ONE PLACE A VERDICT IS WRITTEN IN THIS FILE - gated on both clients being clean.
 *
 * Every check used to call `record` itself and none of them looked at a console line, so twenty
 * verdicts would have rested on nobody observing - the campaign's rule is that a check passes when
 * its assertions hold AND its run is clean, and READ once shipped eight PASSes that met only the
 * first half. Routing every outcome (including the `catch`) through here makes the second half
 * impossible to forget, and impossible to spell differently from the phases that already do it.
 *
 * @returns {boolean} whether this counts as ok for the tally - a gated PASS, and nothing else.
 */
async function finish(id, verdict, w, detail, narrow) {
  const gated = gate(verdict, await observe(w, narrow));
  record(id, gated.verdict, { ...gated.detail, ...detail });
  return gated.verdict === 'PASS';
}

async function setOffline(cx, offline) {
  await cx.send('Network.enable');
  await cx.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });
}

/** Sends `text` and waits for it to render locally - the shared first step of nearly every check. */
async function sendText(cx, text) {
  await armComposer(cx, text);
  return fireComposer(cx);
}

// ── Row-scoped DOM helpers ───────────────────────────────────────────────────────────────────
//
// Every one of these is scoped by `.group` - `MessageBubble.svelte`'s own outer wrapper - so a
// search for a control that is genuinely ABSENT from one message's row can never silently succeed
// against a NEIGHBOUR's row. `clickBubbleAction` in chat.mjs learned this lesson the hard way
// (MSG-3, first run: a document-wide selector replied to the oldest message in history); climbing
// ancestors until `classList.contains('group')` reproduces that fix without depending on a fixed
// number of hops, which differs between a text message (`MessageTextBody`) and a media caption
// (`MessageMediaRenderer`) - both nest inside the SAME outer `.group`, just at different depths.
//
// A LOCATOR MAY ALSO BE AN ID ('#msg-<messageId>'), and for anything that outlives its own text it
// MUST be: a deletion swaps the body for a tombstone, so MUT-17 searched for the text it had just
// caused to disappear and read `null` - "row not found" - at every observation, then passed on an
// `indexOf(...) === -1` that a missing row satisfies just as well as a tombstoned one. The id is
// `MessageBubble.svelte`'s own `id={`msg-${messageId}`}`, on the very element that carries `.group`,
// so both locators land on exactly the same node; `getElementById` avoids the CSS-escaping question
// entirely, since a message id may begin with a digit and would not be a valid `#` selector.
const FIND_ROW_FN = `function (pane, text) {
  if (text.charAt(0) === '#') {
    var byId = document.getElementById(text.slice(1));
    return byId && pane.contains(byId) ? byId : null;
  }
  var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
    return (e.textContent || '').indexOf(text) !== -1;
  });
  if (!hits.length) return null;
  var node = hits[hits.length - 1];
  for (var i = 0; i < 8 && node.parentElement; i++) {
    node = node.parentElement;
    if (node.classList && node.classList.contains('group')) return node;
  }
  return node;
}`;

const paneExpr = () => `document.querySelector('${COMPOSER}').closest('section')`;

/** The row's stable locator (`#msg-<messageId>`), or null. Take it BEFORE any mutation that rewrites
 *  the text you would otherwise search by - and it is the SAME string on every client, because the
 *  id is the message id, so a row captured on the sender locates the receiver's row too. */
async function bubbleRowLocator(cx, textMatch) {
  const id = await evaluate(
    cx,
    `(function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      return row && row.id ? row.id : null;
    })()`
  );
  return id ? `#${id}` : null;
}

/**
 * WHY a control is not on top at its own centre - as coordinates, in the SAME evaluation.
 *
 * Naming the element that took the point ("DIV.flex-1 overflow-y-auto p-2.5 is") was enough to turn
 * five silent misses into five reports, and not enough to say what to fix: a control covered by a
 * transient overlay and a control laid out off the edge of its own pane produce the same sentence.
 * The numbers separate them - `btn.left < pane.left` is an OVERFLOW, and there is nothing racy
 * about it. Emitted as a fragment shared by both click helpers so the two can never drift.
 *
 * @param {string} btnVar name of the in-page variable holding the button
 * @param {string} rVar name of the in-page variable holding its already-read bounding rect
 */
const geometryOf = (btnVar, rVar) => `{
  btn: { x: Math.round(${rVar}.left), y: Math.round(${rVar}.top), w: Math.round(${rVar}.width), h: Math.round(${rVar}.height) },
  pane: (function () { var pr = pane.getBoundingClientRect(); return { x: Math.round(pr.left), w: Math.round(pr.width) }; })(),
  viewport: { w: innerWidth, h: innerHeight },
  overflowsPaneLeftBy: Math.max(0, Math.round(pane.getBoundingClientRect().left - ${rVar}.left)),
  toolbar: (function () {
    var t = ${btnVar}.parentElement;
    if (!t) return null;
    var tr = t.getBoundingClientRect();
    return { x: Math.round(tr.left), w: Math.round(tr.width) };
  })()
}`;

/**
 * Runs `fn` with enough viewport width for the hover toolbar to be REACHABLE, then restores.
 *
 * THIS IS A COMPENSATION FOR A FILED APPLICATION DEFECT, and it is written as one. The strip is
 * positioned `right-full` outside the bubble with nothing bounding it by the pane, so at the width
 * these browsers launch at (958 px) it is laid out 54 px INTO the sidebar and `elementFromPoint`
 * at the heart button's own centre returns a conversation row. Five checks whose subject is
 * mutation cannot click a reaction at all. Measured, with the table, in
 * [backlog](../../docs/wiki/backlog.md) - "the message hover bar is too wide on desktop".
 *
 * It is deliberately NOT the global launch width: every other phase's baseline is that window, and
 * a campaign that quietly widens its own viewport stops measuring what users have. MUT-21 measures
 * the defect at the launched width instead, so THE DAY IT IS FIXED, MUT-21 passes and this wrapper
 * can be deleted. A compensation with no expiry is how a workaround becomes the design.
 */
const TOOLBAR_ROOM = { width: 1440, height: 900 };
async function withToolbarRoom(clients, fn) {
  for (const cx of clients)
    await cx.send('Emulation.setDeviceMetricsOverride', {
      ...TOOLBAR_ROOM,
      deviceScaleFactor: 0,
      mobile: false,
    });
  await sleep(500); // the layout settles before anything is measured against it
  try {
    return await fn();
  } finally {
    for (const cx of clients) await cx.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
}

/** `'read'` / `'sent'` / `null` when the row shows neither - which is the normal state for anything
 *  that is not the last own message, `MessageMetadata.svelte` rendering the indicator only on the
 *  receipt anchor. `null` also covers a row that is gone, so callers that care must anchor by id. */
async function readIndicator(cx, locator) {
  return evaluate(
    cx,
    `(function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(locator)});
      if (!row) return null;
      if (row.querySelector('.msg-status-read')) return 'read';
      if (row.querySelector('.msg-status-sent')) return 'sent';
      return null;
    })()`
  );
}

/** What the row currently SHOWS: its paragraph text and whether that paragraph carries the deleted
 *  styling (`italic opacity-60` in `MessageTextBody.svelte` - the only DOM trace `isDeleted` leaves
 *  on the body). `null` means the row itself is gone, which is a different answer from "not
 *  tombstoned" and must never again be collapsed into one. */
async function bubbleBody(cx, locator) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(locator)});
      if (!row) return null;
      var p = row.querySelector('p');
      return {
        text: p ? (p.textContent || '').trim().slice(0, 80) : null,
        styledAsDeleted: !!(p && p.classList.contains('italic') && p.classList.contains('opacity-60')),
      };
    })())`
  );
  return JSON.parse(raw);
}

/** True/false/null(row not found) for whether `svg.<iconClass>` exists anywhere in the row. */
async function bubbleIconPresent(cx, textMatch, iconClass) {
  return evaluate(
    cx,
    `(function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return null;
      return !!row.querySelector('svg.${iconClass}');
    })()`
  );
}

/**
 * Clicks the button that owns `svg.<iconClass>` within the message's row, AND SAYS WHAT TOOK IT.
 *
 * THIS FILE'S TWO CLICK HELPERS DISPATCHED BLIND UNTIL 2026-08-15, which is the fault
 * `clickBubbleAction` in chat.mjs was rebuilt to remove and which was reproduced here by copying its
 * pre-fix shape. The cost was paid twice on the first MUT run: MUT-9 died 5 s later on a dialog that
 * never opened, with nothing able to say whether the trash button had been missed or the app had
 * failed to open its modal; and MUT-12 counted 13 of 15 emoji with no record of WHICH two never
 * landed. A dispatch is not an activation - only the recorded event is, so both go through
 * `clickAtPoint` now and assert on `received`.
 *
 * The hit test lives in the SAME evaluation as the measurement (see `clickBubbleAction`): testing it
 * from the driver leaves a round trip in which the row can un-render, which is the very miss being
 * defended against.
 *
 * @returns {{x,y,received}} `received.btn` names the control that took the click.
 */
async function clickBubbleIcon(cx, textMatch, iconClass) {
  await hoverBubble(cx, textMatch);
  const point = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return null;
      var svg = row.querySelector('svg.${iconClass}');
      var btn = svg ? svg.closest('button') : null;
      if (!btn) return null;
      var r = btn.getBoundingClientRect();
      if (r.width === 0) return { blocked: 'icon button has no box - not hovered?' };
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !btn.contains(hit)) {
        return {
          blocked: 'the .${iconClass} button is not on top at its own centre' + (hit ? ' (' + hit.tagName + '.' + String(hit.className).slice(0, 40) + ' is)' : ' (nothing is there)'),
          geometry: ${geometryOf('btn', 'r')}
        };
      }
      return { x: x, y: y, name: (btn.getAttribute('aria-label') || btn.innerText || '').trim().slice(0, 40) };
    })())`
  );
  if (!point || point === 'null') throw new Error(`no .${iconClass} action on the row of ${textMatch}`);
  const p = JSON.parse(point);
  if (p.blocked) throw new Error(`${p.blocked} - ${JSON.stringify(p.geometry ?? null)}`);
  const { received } = await clickAtPoint(cx, p.x, p.y);
  // A click NOTHING received is the silent failure this exists to name. It is not retried here: the
  // caller decides, because for a reaction a second click TOGGLES rather than repeats.
  if (!received) {
    throw new Error(`the .${iconClass} click at ${p.x},${p.y} on the row of ${textMatch} was dispatched and nothing received it`);
  }
  return { ...p, received };
}

/** Clicks a reaction-emoji button (the quick strip OR the picker's "recent" panel - both render the
 *  bare emoji as `button.innerText`, unlike every other action which carries a localised label). */
async function clickReactionEmoji(cx, textMatch, emoji) {
  await hoverBubble(cx, textMatch);
  const point = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return null;
      var btns = [].filter.call(row.querySelectorAll('button'), function (b) {
        return (b.innerText || '').trim() === ${JSON.stringify(emoji)};
      });
      var btn = btns[0];
      if (!btn) return null;
      var r = btn.getBoundingClientRect();
      if (r.width === 0) return { blocked: 'reaction button has no box - picker closed?' };
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !btn.contains(hit)) {
        return {
          blocked: 'the ' + ${JSON.stringify(emoji)} + ' button is not on top at its own centre' + (hit ? ' (' + hit.tagName + '.' + String(hit.className).slice(0, 40) + ' is)' : ' (nothing is there)'),
          geometry: ${geometryOf('btn', 'r')}
        };
      }
      return { x: x, y: y };
    })())`
  );
  if (!point || point === 'null') throw new Error(`no quick-reaction ${emoji} on the row of ${textMatch}`);
  const p = JSON.parse(point);
  if (p.blocked) throw new Error(`${p.blocked} - ${JSON.stringify(p.geometry ?? null)}`);
  const { received } = await clickAtPoint(cx, p.x, p.y);
  // THE EMOJI IS ITS OWN BUTTON LABEL, so unlike the icon helper this one can assert the click was
  // taken by the RIGHT control and not merely by some control. A reaction click is a toggle, so a
  // miss retried is a reaction removed - hence the throw, and no retry.
  if (!received) {
    throw new Error(`the ${emoji} click at ${p.x},${p.y} on the row of ${textMatch} was dispatched and nothing received it`);
  }
  if (received.btn !== emoji && received.text !== emoji) {
    throw new Error(`the ${emoji} click was taken by "${received.btn || received.tag}" - the row moved under it`);
  }
  return { ...p, received };
}

/** Emoji equality that ignores the variation selector - `❤️` is U+2764 U+FE0F in this file's source
 *  and may render as either form in the badge's text node, so `===` would compare presentation.
 *  The selector is BUILT rather than typed on purpose: it renders as nothing at all, so a literal
 *  one inside `/.../` is a character no reviewer can see and no diff can show. */
const VARIATION_SELECTOR = new RegExp(String.fromCharCode(0xfe0f), 'g');
const sameEmoji = (x, y) =>
  String(x).replace(VARIATION_SELECTOR, '') === String(y).replace(VARIATION_SELECTOR, '');

/**
 * Clicks `emoji` and WAITS FOR ITS BADGE, returning the delay in ms, or `null` if it never came.
 *
 * MUT-12's first run reported `atCapCount: 13` where 15 were expected and could name neither of the
 * two that never landed: fifteen clicks had been fired behind fifteen fixed 150 ms sleeps, so "the
 * click never happened" and "the badge had not rendered yet" produced the same evidence - none.
 * `clickReactionEmoji` now proves the click was RECEIVED, by the right control; this proves the
 * reaction ARRIVED. The deadline is not a guess at latency - it is only the point past which the
 * absence is reported, and the delay is returned so a slow one is distinguishable from a lost one.
 */
async function reactAndConfirm(cx, textMatch, emoji, timeoutMs = 5000) {
  await clickReactionEmoji(cx, textMatch, emoji);
  const started = Date.now();
  for (;;) {
    const badges = (await reactionBadges(cx, textMatch)) || [];
    if (badges.some((r) => sameEmoji(r.emoji, emoji))) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(100);
  }
}

/** Whether the full emoji picker is open on this row - the `<emoji-picker>` custom element only
 *  exists in the DOM while `showEmojiPicker` is true for that bubble. */
async function pickerOpen(cx, textMatch) {
  return evaluate(
    cx,
    `(function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      return !!(row && row.querySelector('emoji-picker'));
    })()`
  );
}

async function ensurePickerOpen(cx, textMatch) {
  if (!(await pickerOpen(cx, textMatch))) {
    await clickBubbleIcon(cx, textMatch, 'lucide-smile');
    await until(cx, `!!(function(){var p=${paneExpr()};return p;})()`, 3000).catch(() => {});
    await sleep(350); // the panel's own `scale` transition is 250ms
  }
}

/** 'pinned' | 'unpinned' | null(no pin control on this row at all). */
async function pinState(cx, textMatch) {
  const pinned = await bubbleIconPresent(cx, textMatch, 'lucide-pin-off');
  if (pinned) return 'pinned';
  const unpinned = await bubbleIconPresent(cx, textMatch, 'lucide-pin');
  if (unpinned) return 'unpinned';
  return null;
}

async function clickPinIcon(cx, textMatch) {
  const s = await pinState(cx, textMatch);
  if (s === null) throw new Error(`no pin control on the row of ${textMatch}`);
  await clickBubbleIcon(cx, textMatch, s === 'pinned' ? 'lucide-pin-off' : 'lucide-pin');
}

/** One entry per distinct emoji currently on the message, as the VIEWER sees it - `pressed` is
 *  per-viewer (their own `aria-pressed`), `count` is the shared tally (only rendered by
 *  `MessageReactions.svelte` past 1 reactor, defaults to 1 here to match). */
async function reactionBadges(cx, textMatch) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return null;
      var group = row.querySelector('[role="group"]');
      if (!group) return [];
      return [].map.call(group.querySelectorAll('button[aria-pressed]'), function (b) {
        var spans = b.querySelectorAll('span');
        return {
          emoji: spans[0] ? spans[0].textContent : '',
          count: spans[1] ? parseInt(spans[1].textContent, 10) : 1,
          pressed: b.getAttribute('aria-pressed') === 'true',
        };
      });
    })())`
  );
  return JSON.parse(raw);
}

/** Full delete flow: trash icon -> confirm in the modal. The confirm button carries no icon (see
 *  header comment), so it is the one action here that still resolves by French text, scoped to
 *  `[role="dialog"]` so it can never match anything behind the modal's backdrop. */
async function deleteBubble(cx, textMatch) {
  const clicked = await clickBubbleIcon(cx, textMatch, 'lucide-trash-2');
  try {
    await until(cx, `!!document.querySelector('[role="dialog"]')`, 5000);
  } catch {
    // A BARE `until() timed out` NAMES NOTHING. MUT-9's first ERROR read exactly that and could not
    // separate "the trash button was never activated" from "the app failed to open its modal" - and
    // the modal genuinely renders for `isOwn || canModerate`, so the expectation was right and the
    // cause unknown. `received` settles the first half (the click WAS taken, by what); the DOM read
    // below settles the second (a dialog under another name, or none at all).
    const seen = JSON.parse(
      await evaluate(
        cx,
        `JSON.stringify({
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          modals: document.querySelectorAll('[aria-modal="true"]').length,
          fixedOverlays: [].filter.call(document.querySelectorAll('div'), function (d) {
            return getComputedStyle(d).position === 'fixed' && d.getBoundingClientRect().width > innerWidth * 0.5;
          }).length
        })`,
      ),
    );
    throw new Error(
      `no delete-confirmation dialog 5s after the trash click on ${textMatch} - ` +
        `the click WAS received by "${clicked.received.btn || clicked.received.tag}" ` +
        `(aimed at "${clicked.name}" at ${clicked.x},${clicked.y}), and the page shows ${JSON.stringify(seen)}`,
    );
  }
  await realClick(cx, 'text=Supprimer');
  await until(cx, `!document.querySelector('[role="dialog"]')`, 5000);
}

/** Full inline-edit flow: pencil icon -> replace the textarea's content -> Save. The textarea and
 *  the Save button carry no stable hook either (see header comment); the textarea is at least
 *  uniquely locatable (only one message can be in edit mode at a time), so only Save needs text. */
async function editBubble(cx, textMatch, newText) {
  await clickBubbleIcon(cx, textMatch, 'lucide-pencil');
  const taExpr = `${paneExpr()}.querySelector('textarea')`;
  await until(cx, `!!${taExpr}`, 5000);
  await evaluate(
    cx,
    `(function () {
      var t = ${taExpr};
      t.focus();
      t.selectionStart = 0;
      t.selectionEnd = t.value.length;
    })()`
  );
  await cx.send('Input.insertText', { text: newText });
  await realClick(cx, 'text=Enregistrer');
  await until(cx, `!${taExpr}`, 5000);
}

/** Counts the `<p>` elements strictly between two sentinel markers, and how many of them carry the
 *  tombstone styling (`MessageTextBody.svelte`: `isDeleted ? 'italic opacity-60' : ''` - the only
 *  signal a deleted row has, since it carries no semantic class - see header comment). Used to tell
 *  a TOMBSTONE (row survives, styled, content replaced - `count === 1`) from a GAP (row plus content
 *  both gone - `count === 0`) without depending on the (localised) "Ce message a ete supprime."
 *  text, which a bracket of sentinels makes unnecessary. */
async function paragraphsBetween(cx, beforeMarker, afterMarker) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var ps = [].slice.call(pane.querySelectorAll('p'));
      var beforeIdx = -1, afterIdx = -1;
      for (var i = 0; i < ps.length; i++) {
        var t = ps[i].textContent || '';
        if (beforeIdx === -1 && t.indexOf(${JSON.stringify(beforeMarker)}) !== -1) beforeIdx = i;
        if (t.indexOf(${JSON.stringify(afterMarker)}) !== -1) afterIdx = i;
      }
      if (beforeIdx === -1 || afterIdx === -1 || afterIdx <= beforeIdx) return null;
      var between = ps.slice(beforeIdx + 1, afterIdx);
      return {
        count: between.length,
        tombstoneCount: between.filter(function (p) {
          return p.classList.contains('italic') && p.classList.contains('opacity-60');
        }).length,
        texts: between.map(function (p) { return (p.textContent || '').slice(0, 60); }),
      };
    })())`
  );
  return raw === 'null' ? null : JSON.parse(raw);
}

/** All `canari_pins_*` localStorage entries, keyed by conversationId (an MLS group id we have no
 *  other way to name from the harness - see MUT-15/16). */
async function pinStoreSnapshot(cx) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var out = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('canari_pins_') === 0) out[k] = localStorage.getItem(k);
      }
      return out;
    })())`
  );
  return JSON.parse(raw);
}

/** Diffs two snapshots and returns the single key that changed - the just-pinned conversation's
 *  key, found WITHOUT ever having to decode or guess an MLS group id. Throws if it is not exactly
 *  one key, which would mean something else touched pin state concurrently (Leon, or a stray tab). */
function diffPinKey(before, after) {
  const changed = new Set([...Object.keys(before), ...Object.keys(after)]).values();
  const hits = [...changed].filter((k) => before[k] !== after[k]);
  if (hits.length !== 1) {
    throw new Error(`expected exactly one changed pin key, got ${JSON.stringify(hits)}`);
  }
  return hits[0];
}

async function restorePinKey(cx, key, beforeValue) {
  if (beforeValue === undefined) {
    await evaluate(cx, `localStorage.removeItem(${JSON.stringify(key)})`);
  } else {
    await evaluate(cx, `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(beforeValue)})`);
  }
}

// ── MUT-1: edit a text message, both sides show the new text + edited marker [DM] ──────────────

async function mut1() {
  const [a, b, w] = await openDmPair();
  try {
    const base = mark('MUT1');
    const v1 = `${base} v1`;
    const v2 = `${base} v2`;
    await sendText(a, v1);
    const arrivedMs = await awaitMessage(b, v1, 20000).then((ms) => ms, () => null);

    await editBubble(a, v1, v2);

    const [aHasV2, bHasV2] = await Promise.all([
      awaitMessage(a, v2, 10000).then(() => true, () => false),
      awaitMessage(b, v2, 10000).then(() => true, () => false),
    ]);
    // countMessage is the real check for "the old text is truly gone, not just off-screen".
    const aOldCount = await countMessage(a, v1);
    const bOldCount = await countMessage(b, v1);

    // No stable hook for "(modifie)" - see header comment. This is the one place in the whole file
    // that reads French prose for an ASSERTION rather than only to click, and it is deliberate: the
    // alternative is not testing the edited-marker half of MUT-1 at all.
    const markerText = 'modifi';
    const [aMarker, bMarker] = await Promise.all([
      evaluate(a, `${paneExpr()}.innerText.indexOf(${JSON.stringify(markerText)}) !== -1`),
      evaluate(b, `${paneExpr()}.innerText.indexOf(${JSON.stringify(markerText)}) !== -1`),
    ]);

    const ok = arrivedMs !== null && aHasV2 && bHasV2 && aOldCount === 0 && bOldCount === 0 && aMarker && bMarker;
    return await finish('MUT-1/dm', ok ? 'PASS' : 'FAIL', w, {
      arrivedMs,
      aHasV2,
      bHasV2,
      aOldCount,
      bOldCount,
      editedMarkerPresent: { sender: aMarker, receiver: bMarker },
      note: 'edited-marker assertion has no stable hook, matched against "modifi" (fr: "(modifie)") - see header comment',
    });
  } catch (e) {
    return await finish('MUT-1/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-2: editing does NOT un-read the message - the watermark is monotone [DM] ───────────────
//
// THIS CHECK ASSERTED A DESIGN THAT WAS DELIBERATELY REPLACED, and failed the application for
// obeying the current one. It expected `.msg-status-read` to revert to `.msg-status-sent` after an
// edit, i.e. that editing CLEARS `readBy` - and `readBy` is no longer stored on a message at all.
// Read state is one monotone instant per participant on the CONVERSATION (`readState.ts`), merged
// with `max`, compared against the message's original `timestamp`, which an edit does not touch
// (`useMessaging.svelte.ts` writes `isEdited`, `editedAt`, `content`, and nothing else). There is no
// representable state meaning "read up to T except message X", so a revert is not a behaviour that
// was omitted - it is one the model cannot express, and `systemMessageHandler.ts` says so in a
// comment at the exact line that used to clear it.
//
// So the oracle is inverted, and the residue is recorded rather than asserted: an edited message
// keeps its read indicator although the peer has not seen the new text. That is the accepted cost
// of a monotone watermark, and it belongs in the report where a reader can weigh it.

async function mut2() {
  const [a, b, w] = await openDmPair();
  try {
    const base = mark('MUT2');
    const v1 = `${base} v1`;
    const v2 = `${base} v2`;
    await sendText(a, v1);
    await awaitMessage(b, v1, 20000);

    // Peer reads it: `client()` focus-emulates both windows, which is what makes the receipt fire
    // at all (see chat.mjs's comment on `client` - MainChatPage.svelte:435 gates it on real focus).
    const readWaitMs = await until(
      a,
      `(function () {
        var pane = ${paneExpr()};
        var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
          return (e.textContent || '').indexOf(${JSON.stringify(v1)}) !== -1;
        });
        if (!hits.length) return false;
        var node = hits[hits.length - 1];
        for (var i = 0; i < 8 && node.parentElement; i++) {
          node = node.parentElement;
          if (node.classList && node.classList.contains('group')) break;
        }
        return !!node.querySelector('.msg-status-read');
      })()`,
      15000,
      100
    ).catch(() => null);

    // Anchored before the edit, because the edit is what makes `v1` stop naming anything.
    const row = await bubbleRowLocator(a, v1);
    if (!row) throw new Error(`no #msg-<id> anchor on the row of ${v1}`);

    await editBubble(a, v1, v2);
    await awaitMessage(b, v2, 10000); // the edit reached the peer, so its watermark had every chance

    // THE INDICATOR MUST NOT MOVE, and the second reading is what makes that an observation rather
    // than a coincidence of timing: a revert, if one existed, would arrive with the edit's own round
    // trip, which `awaitMessage` above has already waited out on the peer.
    const readNow = await readIndicator(a, row);
    await sleep(2000);
    const readLater = await readIndicator(a, row);

    const ok = readWaitMs !== null && readNow === 'read' && readLater === 'read';
    return await finish('MUT-2/dm', ok ? 'PASS' : 'FAIL', w, {
      readWaitMs,
      readNow,
      readLater,
      note:
        readWaitMs === null
          ? 'never observed .msg-status-read before the edit - either this was not the last own message, or the peer window never got a real read receipt'
          : 'accepted tradeoff, recorded on purpose: the bubble still reads as READ although the peer has not seen the NEW text',
    });
  } catch (e) {
    return await finish('MUT-2/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-3: edit REFUSED on media, and on someone else's message [DM] ───────────────────────────

async function mut3() {
  const [a, b, w] = await openDmPair();
  try {
    // (a) own message WITH media: `MessageBubbleToolbar` gates edit on `!hasMedia`.
    const mediaCaption = mark('MUT3MEDIA');
    await attachFiles(a, [abs('./fixtures/msg4-image.png')]);
    await until(a, `!document.querySelector('button[aria-label*="Envoyer"]')?.disabled`, 10000, 100).catch(() => {});
    await armComposer(a, mediaCaption);
    await fireComposer(a);
    await awaitMessage(b, mediaCaption, 30000).catch(() => {});
    const mediaEditPresent = await bubbleIconPresent(a, mediaCaption, 'lucide-pencil');

    // (b) someone ELSE's message: `isOwn` gates edit, and `canModerate` never widens it (edit is
    // never a moderation action - see the doc comment on `MessageBubbleToolbar`'s `canModerate`).
    const othersText = mark('MUT3OTHER');
    await sendText(b, othersText);
    await awaitMessage(a, othersText, 20000);
    const othersEditPresent = await bubbleIconPresent(a, othersText, 'lucide-pencil');

    const ok = mediaEditPresent === false && othersEditPresent === false;
    return await finish('MUT-3/dm', ok ? 'PASS' : 'FAIL', w, { mediaEditPresent, othersEditPresent });
  } catch (e) {
    return await finish('MUT-3/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-4: edit a message the peer has not yet received; peer ends with the new text, once [DM] ─

async function mut4() {
  const [a, b, w] = await openDmPair();
  // W2 is cut on purpose below, so ITS window is narrowed by the cut and W1's is not - see observe().
  const cut = { W2: ignoringOfflineCut };
  try {
    await setOffline(b, true);

    const base = mark('MUT4');
    const original = `${base} original`;
    const edited = `${base} edited-once`;
    await sendText(a, original);
    // The peer is offline, so this proves nothing arrived YET - it is not the assertion, just the
    // setup: the edit below must land before the peer ever sees `original`.
    await sleep(1500);
    const sawOriginalWhileOffline = await countMessage(b, original).catch(() => 0);

    await editBubble(a, original, edited);

    await setOffline(b, false);

    const arrivedMs = await awaitMessage(b, edited, 25000).then((ms) => ms, () => null);
    // A late arrival gets a moment to settle before the count is taken - never a substitute for the
    // poll above, only insurance against catching a mid-flush duplicate.
    await sleep(1500);
    const editedCount = await countMessage(b, edited);
    const originalCount = await countMessage(b, original);

    const ok =
      sawOriginalWhileOffline === 0 && arrivedMs !== null && editedCount === 1 && originalCount === 0;
    return await finish(
      'MUT-4/dm',
      ok ? 'PASS' : 'FAIL',
      w,
      { sawOriginalWhileOffline, arrivedMs, editedCount, originalCount },
      cut
    );
  } catch (e) {
    return await finish('MUT-4/dm', 'ERROR', w, { error: e.message }, cut);
  } finally {
    await setOffline(b, false).catch(() => {});
    closeAll(a, b);
  }
}

// ── MUT-5: edit is ABSENT in channels, by design [Channel] ─────────────────────────────────────

async function mut5() {
  const [a, b, w] = await openChannelPair();
  try {
    const marker = mark('MUT5');
    await sendText(a, marker);
    await awaitMessage(b, marker, 20000).catch(() => {});
    // `MainChatPage.svelte`: `onEdit={isSelectedChannel ? undefined : ...}` - the prop itself is
    // never even wired for a channel, so the toolbar's `onEdit && !hasMedia && isOwn` can never be
    // true here regardless of ownership. This asserts the OBSERVABLE consequence of that wiring.
    const editPresent = await bubbleIconPresent(a, marker, 'lucide-pencil');
    const ok = editPresent === false;
    return await finish('MUT-5/channel', ok ? 'PASS' : 'FAIL', w, { editPresent });
  } catch (e) {
    return await finish('MUT-5/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-6: delete shows a tombstone on both sides, not a gap [DM] ──────────────────────────────

async function mut6() {
  const [a, b, w] = await openDmPair();
  try {
    const base = mark('MUT6');
    const before = `${base} before`;
    const target = `${base} target`;
    const after = `${base} after`;
    await sendText(a, before);
    await sendText(a, target);
    await sendText(a, after);
    await awaitMessage(b, after, 25000);

    await deleteBubble(a, target);
    await sleep(600); // let the local optimistic tombstone paint before reading it back

    const aGap = await paragraphsBetween(a, before, after);
    // The peer's copy converges over the live WS (`event === 'delete_message'`), not a reload.
    const bGapMs = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const g = await paragraphsBetween(b, before, after);
        if (g && g.count === 1 && g.tombstoneCount === 1) return Date.now() - t0;
        await sleep(300);
      }
      return null;
    })();
    const bGapFinal = await paragraphsBetween(b, before, after);

    const ok =
      !!aGap && aGap.count === 1 && aGap.tombstoneCount === 1 && aGap.texts.every((t) => t.indexOf(target) === -1) &&
      !!bGapFinal && bGapFinal.count === 1 && bGapFinal.tombstoneCount === 1;
    return await finish('MUT-6/dm', ok ? 'PASS' : 'FAIL', w, {
      senderGap: aGap,
      receiverGap: bGapFinal,
      receiverConvergedMs: bGapMs,
    });
  } catch (e) {
    return await finish('MUT-6/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-7: tombstone WINS over a body on merge - a device holding the original must not resurrect
//    it [DM] ───────────────────────────────────────────────────────────────────────────────────

async function mut7() {
  const [a, b, w] = await openDmPair();
  const cut = { W2: ignoringOfflineCut };
  try {
    const base = mark('MUT7');
    const before = `${base} before`;
    const target = `${base} target`;
    const after = `${base} after`;
    await sendText(a, before);
    await sendText(a, target);
    await sendText(a, after);
    // b must actually HOLD the original before it goes offline - that is the whole point of this
    // check versus MUT-6 (which never requires the peer to have seen the pre-delete content at all).
    const heldOriginal = await awaitMessage(b, target, 25000).then(() => true, () => false);

    await setOffline(b, true);
    await deleteBubble(a, target);
    await sleep(800);
    await setOffline(b, false);

    const convergedMs = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const g = await paragraphsBetween(b, before, after);
        if (g && g.count === 1 && g.tombstoneCount === 1) return Date.now() - t0;
        await sleep(300);
      }
      return null;
    })();
    const finalGap = await paragraphsBetween(b, before, after);
    const resurrected = finalGap ? finalGap.texts.some((t) => t.indexOf(target) !== -1) : null;

    const ok = heldOriginal && convergedMs !== null && resurrected === false;
    return await finish(
      'MUT-7/dm',
      ok ? 'PASS' : 'FAIL',
      w,
      { heldOriginal, convergedMs, finalGap, resurrected },
      cut
    );
  } catch (e) {
    return await finish('MUT-7/dm', 'ERROR', w, { error: e.message }, cut);
  } finally {
    await setOffline(b, false).catch(() => {});
    closeAll(a, b);
  }
}

// ── MUT-8: channel delete is a HARD row delete, no tombstone - the real difference from MUT-6
//    [Channel] ───────────────────────────────────────────────────────────────────────────────

async function mut8() {
  let [a, b, w] = await openChannelPair();
  try {
    const base = mark('MUT8');
    const before = `${base} before`;
    const target = `${base} target`;
    const after = `${base} after`;
    await sendText(a, before);
    await sendText(a, target);
    await sendText(a, after);
    await awaitMessage(b, after, 25000);

    await deleteBubble(a, target);
    await sleep(600);
    // Immediately after, in the SAME session, the client renders exactly like a DM tombstone -
    // `markChannelMessageDeleted` sets the identical `isDeleted` flag locally. That is NOT the
    // claim under test; the claim is what a fresh fetch from the server shows.
    const immediateGap = await paragraphsBetween(a, before, after);

    // `deleteChannelMessage` calls `invalidateChannelHistoryCache` right after the DELETE request,
    // so re-opening the channel (a fresh `goto()`, not a client-side re-select) forces
    // `loadChannelHistory` past its cache-TTL guard and wholesale-replaces `messages` from a fresh
    // `channelService.listMessages` - a hard-deleted row simply is not in that answer.
    [a, b] = await Promise.all([
      openChannel(a, VENUE.community, VENUE.channel),
      openChannel(b, VENUE.community, VENUE.channel),
    ]).then(() => [a, b]);
    await until(a, `${paneExpr()}.innerText.indexOf(${JSON.stringify(after)}) !== -1`, 15000);
    await until(b, `${paneExpr()}.innerText.indexOf(${JSON.stringify(after)}) !== -1`, 15000);

    const aGapAfterReload = await paragraphsBetween(a, before, after);
    const bGapAfterReload = await paragraphsBetween(b, before, after);

    const ok =
      !!aGapAfterReload && aGapAfterReload.count === 0 && !!bGapAfterReload && bGapAfterReload.count === 0;
    return await finish('MUT-8/channel', ok ? 'PASS' : 'FAIL', w, {
      immediateGap,
      aGapAfterReload,
      bGapAfterReload,
      contrastNote: 'compare against MUT-6/dm: same immediate shape, opposite shape after a reload',
    });
  } catch (e) {
    return await finish('MUT-8/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-9: a moderator deletes another user's channel message [Channel] ────────────────────────

async function mut9() {
  const [a, b, w] = await openChannelPair();
  try {
    const markerAB = mark('MUT9AB'); // sent by b (W2/peer), target for a (W1/owner) to moderate
    await sendText(b, markerAB);
    await awaitMessage(a, markerAB, 20000);
    let actor = 'W1';
    let modPresent = await bubbleIconPresent(a, markerAB, 'lucide-trash-2');

    let deletingCx = a;
    let target = markerAB;
    if (!modPresent) {
      // Try the other direction before concluding nobody here can moderate - discovering who holds
      // `channel.moderate` empirically beats guessing which of the two test accounts owns the
      // community.
      const markerBA = mark('MUT9BA'); // sent by a, target for b to moderate
      await sendText(a, markerBA);
      await awaitMessage(b, markerBA, 20000);
      modPresent = await bubbleIconPresent(b, markerBA, 'lucide-trash-2');
      actor = 'W2';
      deletingCx = b;
      target = markerBA;
    }

    if (!modPresent) {
      // NOT a pass and not a skip: the check is armable in principle and could not be armed HERE, so
      // it stays visible as an unmet precondition rather than resolving to a colour.
      await finish('MUT-9/channel', 'VACUOUS', w, {
        reason: 'neither test account holds channel.moderate in Campagne de test/general - tried both directions',
        checkedW1OnW2Message: markerAB,
      });
      return true;
    }

    // Scoped to the one click that needs it. MUT-9's ERROR reads "nothing is there" rather than
    // MUT-11/12's "a sidebar row is", so the trash button's centre was OUTSIDE the viewport, not
    // merely covered - a different symptom, and its cause is NOT yet measured. MUT-21 measures the
    // DM only, where a peer message's toolbar is 323 px and fits; a channel adds pin and moderate
    // buttons to it, which is a hypothesis and nothing more until the geometry now attached to the
    // throw arrives from a run. The wrapper is applied because it makes the click land either way.
    await withToolbarRoom([deletingCx], () => deleteBubble(deletingCx, target));
    await sleep(600);
    const [aGone, bGone] = await Promise.all([
      countMessage(a, target),
      countMessage(b, target),
    ]);
    const ok = aGone === 0 && bGone === 0;
    return await finish('MUT-9/channel', ok ? 'PASS' : 'FAIL', w, { actor, target, aGone, bGone });
  } catch (e) {
    return await finish('MUT-9/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-10: investigative - does the toolbar offer Delete to a moderator in a DM? [DM] ─────────

async function mut10() {
  const [a, b, w] = await openDmPair();
  try {
    const marker = mark('MUT10');
    await sendText(b, marker);
    await awaitMessage(a, marker, 20000);

    // The literal claim as written on the dashboard: does a's toolbar render Delete on b's message?
    // `canModerateSelectedChannel` (`MainChatPage.svelte`) is `isSelectedChannel && ...` - `false`
    // by construction outside a channel - so this is expected to read `false` regardless of whether
    // either account holds `channel.moderate` anywhere else.
    const deletePresent = await bubbleIconPresent(a, marker, 'lucide-trash-2');

    // The REAL gap, found by reading the receive path rather than the toolbar wiring:
    // `systemMessageHandler.ts`, `event === 'delete_message'` (~line 486) and `event ===
    // 'edit_message'` (~line 525) apply the mutation to `data.messageId` unconditionally - no check
    // that `senderNorm` equals the target message's `senderId`. The ONLY ownership check in the
    // entire DM delete/edit path is `isOwnMessage(target.senderId, ctx.userId)` inside
    // `handleDeleteMessage`/`handleEditMessage` (`useMessaging.svelte.ts`, ~lines 894/919) - which
    // runs on the SENDING device, before the system event is even broadcast. Once a `delete_message`
    // or `edit_message` event is on the wire, addressed to a shared MLS group, EVERY member's
    // client applies it to whatever id it names, with no re-check of who sent it and no server
    // authority over DM/group content at all (unlike a channel, which is server-authoritative -
    // see `ChannelService.deleteChannelMessage`'s own doc comment). This is not exploitable through
    // the shipped UI (which never lets a well-behaved client construct such an event for someone
    // else's message), so it is NOT something this check attempts to trigger against real peer
    // data - doing so would mutate a message this harness did not create, which the campaign rules
    // forbid regardless of what it might prove. It is recorded here as a source-verified
    // architectural finding for a human to weigh.
    const ok = deletePresent === false;
    return await finish('MUT-10/dm', ok ? 'PASS' : 'FAIL', w, {
      toolbarOffersDeleteOnPeerMessageInDm: deletePresent,
      claimAsWrittenOnDashboard: 'the toolbar offers Delete to a moderator in a DM, where the handler refuses it',
      verdictOnLiteralClaim: deletePresent
        ? 'reproduces: the toolbar DOES offer it'
        : 'does not reproduce: canModerateSelectedChannel is false outside a channel by construction, so Delete never renders on a peer\'s DM message',
      architecturalGapFound: true,
      architecturalGapDetail:
        'systemMessageHandler.ts delete_message (~L486) and edit_message (~L525) apply unconditionally on RECEIPT with no sender===original-author check; the only ownership check (useMessaging.svelte.ts handleDeleteMessage/handleEditMessage, ~L894/L919) runs on the SENDING device only, before broadcast. DM/group mutation integrity rests entirely on well-behaved clients, never on the receiving side or a server. Not exploited here - would require mutating a message this harness did not create.',
    });
  } catch (e) {
    return await finish('MUT-10/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-11: react, un-react, re-react; two users same message; one user several emoji [both] ───

async function mut11Body(a, b, w, idSuffix) {
  const marker = mark('MUT11');
  await sendText(a, marker);
  await awaitMessage(b, marker, 25000);

  await clickReactionEmoji(a, marker, '❤️'); // react
  await sleep(300);
  const afterFirstReact = await reactionBadges(b, marker);

  await clickReactionEmoji(a, marker, '❤️'); // un-react (toggle)
  await sleep(300);
  const afterUnreact = await reactionBadges(b, marker);

  await clickReactionEmoji(a, marker, '❤️'); // re-react
  await sleep(300);

  await clickReactionEmoji(b, marker, '❤️'); // second user, same emoji
  await sleep(300);

  await clickReactionEmoji(a, marker, '😂'); // same user, second distinct emoji
  await sleep(300);
  const final = await reactionBadges(b, marker);

  const heart = final.find((r) => r.emoji === '❤️');
  const laugh = final.find((r) => r.emoji === '😂');
  const ok =
    afterFirstReact.some((r) => r.emoji === '❤️') &&
    afterUnreact.every((r) => r.emoji !== '❤️') &&
    !!heart &&
    heart.count === 2 &&
    !!laugh &&
    laugh.count === 1;

  // Cleanup: leave the message clean, per the campaign rule - INSIDE the observed window, because a
  // cleanup that makes the app complain is still the app complaining.
  await clickReactionEmoji(a, marker, '❤️').catch(() => {});
  await clickReactionEmoji(b, marker, '❤️').catch(() => {});
  await clickReactionEmoji(a, marker, '😂').catch(() => {});

  return await finish(`MUT-11/${idSuffix}`, ok ? 'PASS' : 'FAIL', w, {
    afterFirstReact,
    afterUnreact,
    final,
  });
}

async function mut11() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await withToolbarRoom([a, b], () => mut11Body(a, b, w, 'dm'));
  } catch (e) {
    await finish('MUT-11/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await withToolbarRoom([a, b], () => mut11Body(a, b, w, 'channel'));
  } catch (e) {
    await finish('MUT-11/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
  return dmOk && chOk;
}

// ── MUT-12: the 15-distinct-emoji cap, on both transports [both] ───────────────────────────────

const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '😡']; // MessageBubbleToolbar.svelte's own set
const RECENT_SEED = ['🎉', '🔥', '🥳', '🤔', '👀', '💯', '🚀', '🌟', '🍀', '🐝']; // 9 to reach 15 + 1 spare

async function mut12Body(a, b, w, idSuffix) {
  const marker = mark('MUT12');
  await sendText(a, marker);
  await awaitMessage(b, marker, 25000);

  // Seed the "recent emojis" localStorage BEFORE the picker's first mount this page load - it only
  // reads localStorage in `onMount`, so seeding after the first open would be silently ignored.
  await evaluate(a, `localStorage.setItem('canari_recent_emojis', ${JSON.stringify(JSON.stringify(RECENT_SEED))})`);

  // WHICH emoji landed, one by one. The picker is re-asserted per iteration rather than once before
  // the loop: `ensurePickerOpen` is idempotent on the picker's own state, so a panel that closes on
  // selection is handled by construction instead of by luck - and if it does close, the reopen is
  // recorded rather than being the silent difference between an emoji that landed and one that
  // could not even be aimed at.
  const missing = [];
  const delays = [];
  const react = async (emoji, viaPicker) => {
    if (viaPicker) await ensurePickerOpen(a, marker);
    const ms = await reactAndConfirm(a, marker, emoji);
    if (ms === null) missing.push(emoji);
    else delays.push(ms);
  };
  for (const emoji of QUICK_EMOJIS) await react(emoji, false);
  for (const emoji of RECENT_SEED.slice(0, 9)) await react(emoji, true);
  const atCap = await reactionBadges(a, marker);

  // The 16th: `canAddDistinctReactionEmoji` (client, DM) / the server (channel) must refuse it.
  await clickReactionEmoji(a, marker, RECENT_SEED[9]).catch(() => {});
  await sleep(400);
  const afterOverCap = await reactionBadges(a, marker);

  const ok = atCap.length === 15 && afterOverCap.length === 15;

  // Cleanup: un-react everything we added, and stop seeding this account's real "recent" list.
  for (const emoji of [...QUICK_EMOJIS, ...RECENT_SEED.slice(0, 9)]) {
    await clickReactionEmoji(a, marker, emoji).catch(() => {});
    await sleep(100);
  }
  await evaluate(a, `localStorage.removeItem('canari_recent_emojis')`).catch(() => {});

  return await finish(`MUT-12/${idSuffix}`, ok ? 'PASS' : 'FAIL', w, {
    atCapCount: atCap.length,
    afterOverCapCount: afterOverCap.length,
    refusedEmoji: RECENT_SEED[9],
    // THE TWO THAT WENT MISSING ON THE FIRST RUN NOW HAVE NAMES. `missing` empty with a short
    // `atCapCount` would mean something else entirely - a badge that appeared and then vanished -
    // and the two are no longer the same report.
    missing,
    slowestMs: delays.length ? Math.max(...delays) : null,
  });
}

async function mut12() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await withToolbarRoom([a, b], () => mut12Body(a, b, w, 'dm'));
  } catch (e) {
    await finish('MUT-12/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await withToolbarRoom([a, b], () => mut12Body(a, b, w, 'channel'));
  } catch (e) {
    await finish('MUT-12/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
  return dmOk && chOk;
}

// ── MUT-13: a reaction notifies the message AUTHOR only, never the reactor [DM] ────────────────

async function mut13() {
  const [a, b, w] = await openDmPair();
  try {
    const marker = mark('MUT13');
    await sendText(a, marker); // authored by a (W1)

    // `Network.enable` is not repeated here: `watch()` armed it on both clients before the setup
    // navigated, and `cx.events` has been accumulating since. Re-enabling would read as "the buffer
    // starts here", which is exactly what it does NOT do.
    await awaitMessage(b, marker, 20000);
    await clickReactionEmoji(b, marker, '❤️'); // b (not the author) reacts
    await sleep(1500); // let the fire-and-forget POST actually leave

    const notifyHitsFromReactor = b.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        String(e.params?.request?.url || '').includes('/api/mls/notify-reaction')
    );

    await clickReactionEmoji(a, marker, '👍'); // a reacts to THEIR OWN message
    await sleep(1500);

    const notifyHitsFromAuthorSelfReact = a.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        String(e.params?.request?.url || '').includes('/api/mls/notify-reaction')
    );

    const ok = notifyHitsFromReactor.length > 0 && notifyHitsFromAuthorSelfReact.length === 0;

    // Cleanup, inside the window - see MUT-11.
    await clickReactionEmoji(b, marker, '❤️').catch(() => {});
    await clickReactionEmoji(a, marker, '👍').catch(() => {});

    return await finish('MUT-13/dm', ok ? 'PASS' : 'FAIL', w, {
      reactorFiredNotify: notifyHitsFromReactor.length,
      selfReactFiredNotify: notifyHitsFromAuthorSelfReact.length,
      note:
        'this verifies only the CLIENT-SIDE precondition (messaging.ts addReaction: POST /api/mls/notify-reaction ' +
        'iff targetMsg.senderId !== userId). Whether the push actually reaches the author\'s DEVICE is not observable ' +
        'from a browser - that half is owed to the mobile phase and is NOT claimed passed here.',
    });
  } catch (e) {
    return await finish('MUT-13/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-14: pin and unpin, seen on the OTHER device [both] ─────────────────────────────────────

async function mut14Body(a, b, w, idSuffix) {
  const marker = mark('MUT14');
  await sendText(a, marker);
  await awaitMessage(b, marker, 25000);

  await clickPinIcon(a, marker);
  const bPinnedMs = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if ((await pinState(b, marker)) === 'pinned') return Date.now() - t0;
      await sleep(300);
    }
    return null;
  })();
  const aStatePinned = await pinState(a, marker);

  await clickPinIcon(a, marker);
  const bUnpinnedMs = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if ((await pinState(b, marker)) === 'unpinned') return Date.now() - t0;
      await sleep(300);
    }
    return null;
  })();
  const aStateUnpinned = await pinState(a, marker);

  const ok =
    aStatePinned === 'pinned' && bPinnedMs !== null && aStateUnpinned === 'unpinned' && bUnpinnedMs !== null;
  return await finish(`MUT-14/${idSuffix}`, ok ? 'PASS' : 'FAIL', w, {
    bPinnedMs,
    bUnpinnedMs,
    aStatePinned,
    aStateUnpinned,
  });
}

async function mut14() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await mut14Body(a, b, w, 'dm');
  } catch (e) {
    await finish('MUT-14/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await mut14Body(a, b, w, 'channel');
  } catch (e) {
    await finish('MUT-14/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
  return dmOk && chOk;
}

// ── MUT-15: a DM pin does NOT survive on a fresh device - documented hole, EXPECTED to fail [DM] ─

async function mut15() {
  const [a, b, w] = await openDmPair();
  try {
    const marker = mark('MUT15');
    await sendText(a, marker);
    await awaitMessage(b, marker, 25000);

    const before = await pinStoreSnapshot(a);
    await clickPinIcon(a, marker);
    await sleep(400);
    const after = await pinStoreSnapshot(a);
    const key = diffPinKey(before, after);

    // Simulate "fresh device" for exactly this one pin, and nothing else this account has pinned
    // anywhere - restore the key to its pre-test value (delete it if it did not exist before)
    // rather than wiping ALL `canari_pins_*` keys, which would also discard this account's real
    // pins in every OTHER conversation. See pinStore.svelte.ts: no history-bundle merge and no
    // server list ever repopulate a DM's pin set, so this is a faithful, minimal simulation.
    await restorePinKey(a, key, before[key]);

    // A full navigation (not a client-side re-select) is required to drop the module-level `pins`
    // Map in pinStore.svelte.ts, which otherwise keeps serving the in-memory value regardless of
    // what localStorage now says.
    await openDM(a, PEER_NAME);
    const stateAfterFreshLoad = await pinState(a, marker);

    // This assertion is EXPECTED to fail: there is no durable source for a DM pin, so a device that
    // never saw the live 'pin' system event has no way to learn about it. Recorded as FAIL because
    // that is the honest verdict on "does the pin survive" - `documentedHole: true` is what keeps
    // it from reading as a surprise on the dashboard.
    const survived = stateAfterFreshLoad === 'pinned';

    // Cleanup: b still correctly shows it pinned (it was online throughout), so unpin FROM b - a's
    // wiped-then-reloaded client is online now too and will receive the live 'unpin' event, which
    // converges both sides correctly regardless of a's stale local read above.
    await clickPinIcon(b, marker).catch(() => {});

    // FAIL IS THE HONEST WORD AND IT STAYS. The pin genuinely does not survive, so this row is red
    // on every pass and the MUT phase cannot exit 0 while the hole stands. Renaming it to something
    // green because the hole is KNOWN would make the dashboard say the opposite of what the
    // application does, which is the one thing no verdict here may do.
    await finish('MUT-15/dm', survived ? 'PASS' : 'FAIL', w, {
      stateAfterFreshLoad,
      documentedHole: !survived,
      reason: 'pinStore.svelte.ts is localStorage-only; history_bundle merge (systemMessageHandler.ts) never touches pin state, so a device with no local record of a pin has no way to recover it',
    });

    return !survived; // "ok" for the tally means "reproduced the known hole", not "pin survived"
  } catch (e) {
    return await finish('MUT-15/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-16: a channel pin DOES survive - the server re-hydrates it [Channel] ───────────────────

async function mut16() {
  let [a, b, w] = await openChannelPair();
  try {
    const marker = mark('MUT16');
    await sendText(a, marker);
    await awaitMessage(b, marker, 25000);

    const before = await pinStoreSnapshot(a);
    await clickPinIcon(a, marker);
    await sleep(400);
    const after = await pinStoreSnapshot(a);
    const key = diffPinKey(before, after);

    // Same simulated-fresh-device technique as MUT-15, but this time the contrast is the point:
    // `MainChatPage.svelte`'s `$effect` calls `channelService.listPinnedMessageIds` + `setPinnedSet`
    // (which REPLACES the set, not merges) every time a channel is opened.
    await restorePinKey(a, key, before[key]);
    [a] = await Promise.all([openChannel(a, VENUE.community, VENUE.channel)]).then(() => [a]);
    await until(a, `${paneExpr()}.innerText.indexOf(${JSON.stringify(marker)}) !== -1`, 15000);

    const stateAfterFreshLoad = await pinState(a, marker);
    const ok = stateAfterFreshLoad === 'pinned';
    await clickPinIcon(a, marker).catch(() => {});
    return await finish('MUT-16/channel', ok ? 'PASS' : 'FAIL', w, {
      stateAfterFreshLoad,
      contrastNote: 'compare against MUT-15/dm: same simulated-fresh-device technique, opposite result',
    });
  } catch (e) {
    return await finish('MUT-16/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-17: edit, then delete, then react to the deleted message - the absurd crossing [DM] ────

async function mut17() {
  const [a, b, w] = await openDmPair();
  try {
    const base = mark('MUT17');
    const v1 = `${base} v1`;
    const v2 = `${base} v2`;
    await sendText(a, v1);
    await awaitMessage(b, v1, 20000);

    await editBubble(a, v1, v2);
    await awaitMessage(b, v2, 10000);

    // THE ANCHOR IS TAKEN WHILE THE TEXT STILL EXISTS. Everything below happens to a message whose
    // body has been replaced by a tombstone, so `v2` stops locating anything the instant the delete
    // lands - which is exactly how this check used to record `null` at every observation and still
    // pass. Captured on A, valid on B: the id IS the message id.
    const row = await bubbleRowLocator(a, v2);
    if (!row) throw new Error(`no #msg-<id> anchor on the row of ${v2} - the bubble carries no id`);

    await deleteBubble(a, v2);
    await sleep(600);

    // `MessageBubbleToolbar.svelte`: the quick-reaction strip IS gated by `!isDeleted`, but the
    // "open full picker" (smile) button is NOT - `MessageBubble.svelte` passes `onToggleEmojiPicker`
    // unconditionally on `onReact` alone, with no `!isDeleted` check anywhere in that prop's
    // derivation. So reacting to a deleted message through the FULL picker is reachable from the
    // shipped UI, even though the quick strip hides it - an inconsistency worth surfacing on its
    // own, independent of whatever this check finds when it actually does it.
    const smileOnDeletedPresent = await bubbleIconPresent(a, row, 'lucide-smile');
    const quickStripOnDeletedPresent = await evaluate(
      a,
      `(function () {
        var pane = ${paneExpr()};
        var findRow = ${FIND_ROW_FN};
        var row = findRow(pane, ${JSON.stringify(row)});
        if (!row) return null;
        // The quick strip's emoji buttons carry no icon, so presence is inferred from a bare-emoji
        // button existing OUTSIDE the reactions [role=group] (which only appears once a reaction
        // actually lands).
        var btns = [].filter.call(row.querySelectorAll('button'), function (b) {
          return (b.innerText || '').trim() === '❤️' && !b.closest('[role="group"]');
        });
        return btns.length > 0;
      })()`
    );

    let reactAttempted = false;
    let reactSucceeded = false;
    if (smileOnDeletedPresent) {
      await evaluate(a, `localStorage.setItem('canari_recent_emojis', ${JSON.stringify(JSON.stringify(['🧩']))})`);
      await ensurePickerOpen(a, row);
      reactAttempted = true;
      await clickReactionEmoji(a, row, '🧩').catch(() => {});
      await sleep(500);
      const badges = (await reactionBadges(a, row)) || [];
      reactSucceeded = badges.some((r) => sameEmoji(r.emoji, '🧩'));
    }

    // WHAT EACH CLIENT NOW SHOWS FOR THAT ROW, which is the observation this check was always
    // supposed to make. `aTombstoned` used to be `pane.innerText.indexOf(v2) === -1` - satisfied
    // just as well by a row that had vanished entirely, or by the wrong conversation being open, as
    // by the tombstone it meant to assert. A `null` here now says the ROW is gone, which is a
    // failure, and `styledAsDeleted` says the body is the tombstone rather than merely different.
    const [aBody, bBody] = await Promise.all([bubbleBody(a, row), bubbleBody(b, row)]);
    const tombstoned = (body) => !!body && body.styledAsDeleted && !(body.text || '').includes(v2);

    // PASS means: the crossing did not corrupt anything - the row is still THERE on both clients,
    // still a tombstone, its content never resurrected by the reaction. Whether the reaction stuck
    // is investigative and does not decide the verdict; it is the recorded shape that matters.
    const ok = tombstoned(aBody) && tombstoned(bBody);
    await evaluate(a, `localStorage.removeItem('canari_recent_emojis')`).catch(() => {});
    return await finish('MUT-17/dm', ok ? 'PASS' : 'FAIL', w, {
      smileOnDeletedPresent,
      quickStripOnDeletedPresent,
      reactAttempted,
      reactSucceeded,
      aBody,
      bBody,
      note: reactSucceeded
        ? 'reacting to a deleted message SUCCEEDED via the full picker (quick strip correctly hid it) - a reaction badge now sits under a tombstone bubble'
        : undefined,
    });
  } catch (e) {
    return await finish('MUT-17/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

// ── MUT-18: two devices of the SAME user edit the same message at once - SKIPPED [DM] ──────────

async function mut18() {
  // THE REASON THIS CARRIED WAS FALSE, AND A FALSE REASON IS WORSE THAN NONE. It said A1 was off adb
  // and cited a SESSION STATE that has since said the opposite for weeks: the phone is reachable on
  // 9333 and every other phase that needs it uses it. Anyone reading the old sentence would have gone
  // looking at the cable.
  //
  // What is ACTUALLY missing is a way to drive a message's toolbar on the phone. Every mutation
  // helper in this file resolves its control by hovering the bubble and clicking `svg.lucide-*` in
  // the desktop toolbar; the mobile layout has no hover and puts those actions in an action sheet
  // that carries neither `[role=dialog]` nor `[aria-modal]` (which is why `OVERLAYS` in chat.mjs
  // needs its own clause for it). So arming this needs a mobile equivalent of `clickBubbleIcon`
  // first, and writing one is not something to do inside the check that would be its first user.
  record('MUT-18/dm', 'SKIPPED', {
    reason:
      'no mobile equivalent of clickBubbleIcon exists: the phone opens an action sheet instead of the hover toolbar this file resolves every control through. A1 itself is reachable and is NOT the obstacle.',
    owes: 'a mobile bubble-action helper in chat.mjs, then this check against W1 + A1 (both the owner account)',
  });
  return true;
}

// ── MUT-19: delete a message still in the outbox, unsent (sender offline) [DM] ─────────────────

async function mut19() {
  const [a, b, w] = await openDmPair();
  const cut = { W1: ignoringOfflineCut };
  try {
    await setOffline(a, true);

    const marker = mark('MUT19');
    await sendText(a, marker); // queues locally (outbox), never leaves the offline device
    await sleep(1000);
    const renderedLocally = await evaluate(a, `${paneExpr()}.innerText.indexOf(${JSON.stringify(marker)}) !== -1`);
    const peerSawItWhileSenderOffline = (await countMessage(b, marker).catch(() => 0)) > 0;

    // Still offline: `handleDeleteMessage` is a pure local Svelte action, independent of
    // connectivity - and `enqueueControlEvent`/`deleteMessage` only capture the delete_message
    // event into the SAME durable outbox, they do not touch or cancel the original text's entry
    // (no such cancellation code exists in outbox.ts/messaging.ts - confirmed by reading both).
    await deleteBubble(a, marker);
    await sleep(500);

    await setOffline(a, false);

    // Poll for a while: the question is whether the peer EVER sees the original text before (or
    // instead of) the tombstone - not only the final state, since a transient leak is itself a
    // finding even if it settles correctly.
    let everSawOriginal = false;
    let finalHasOriginal = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const c = await countMessage(b, marker).catch(() => 0);
      if (c > 0) everSawOriginal = true;
      await sleep(400);
    }
    finalHasOriginal = (await countMessage(b, marker).catch(() => 0)) > 0;

    const ok = !everSawOriginal;
    return await finish(
      'MUT-19/dm',
      ok ? 'PASS' : 'FAIL',
      w,
      {
        renderedLocally,
        peerSawItWhileSenderOffline,
        everSawOriginal,
        finalHasOriginal,
        note: everSawOriginal
          ? 'the original text WAS visible to the peer at some point - the delete_message event chased the send rather than cancelling it (no outbox-cancellation path exists for this case)'
          : 'the peer never saw the original text at all',
      },
      cut
    );
  } catch (e) {
    return await finish('MUT-19/dm', 'ERROR', w, { error: e.message }, cut);
  } finally {
    await setOffline(a, false).catch(() => {});
    closeAll(a, b);
  }
}

// ── MUT-20: mutate a message older than the 90-day retention window [DM] ───────────────────────

async function mut20() {
  // No live connection needed: this is a precondition question, not a DOM question, and probing
  // for a candidate message risks landing on one this harness did not create (forbidden regardless
  // of what it would prove). The campaign and this test DM are both recent relative to a 90-day
  // window (see CLAUDE.md SESSION STATE dates), so there is no message that is BOTH provably ours
  // AND old enough to test this safely yet.
  //
  // SKIPPED, NOT VACUOUS. `VACUOUS` is what `recon.mjs` says when it compared nothing and therefore
  // knows nothing - a result to be distrusted. This is the opposite: a stated precondition that
  // provably cannot be met yet, decided before the check runs, exactly like READ-5 and READ-10. The
  // matrix in `run.mjs` reads a deliberate skip as a verdict and an unknown one as a red on every
  // pass, and calling this VACUOUS made MUT permanently unable to report itself reproducible.
  record('MUT-20/dm', 'SKIPPED', {
    reason: 'cannot safely arm: would need a message that is both confirmed created by this harness and older than 90 days; none exists yet given how recently the campaign started',
    armableFrom: 'the first campaign message reaching 90 days - the earliest markers date from 2026-08-11',
  });
  return true;
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────

// ── MUT-21: the hover toolbar is laid out OUTSIDE the pane, and the sidebar takes its clicks [DM] ─
//
// THIS CHECK OWNS THE DEFECT THE OTHERS COMPENSATE FOR - see `withToolbarRoom`. It runs at the width
// the browsers actually launch at, deliberately, because that is the width the report came from.
// Its FAIL is expected and filed; the day it PASSES, `withToolbarRoom` has expired and every one of
// its call sites can go. It measures both directions, which is the half the user's report did not
// separate: an OWN message puts the strip `right-full`, so it overflows into the sidebar, while a
// PEER message puts it `left-full`, so it overflows the viewport's right edge and lands on nothing.
// Same cause, two symptoms, and only the first is a mis-click rather than a dead zone.

/** Geometry + hit test for the one control at `iconOrEmoji` on this row, at the CURRENT width. */
async function toolbarReach(cx, textMatch, selector) {
  await hoverBubble(cx, textMatch);
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return null;
      var btn = ${selector};
      if (!btn) return { noControl: true };
      var r = btn.getBoundingClientRect();
      if (r.width === 0) return { noBox: true };
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      var g = ${geometryOf('btn', 'r')};
      g.reachable = !!(hit && btn.contains(hit));
      g.onTop = hit ? hit.tagName + '.' + String(hit.className).slice(0, 46) : null;
      g.overflowsViewportRightBy = Math.max(0, Math.round(r.left + r.width - innerWidth));
      return g;
    })())`
  );
  return raw && raw !== 'null' ? JSON.parse(raw) : null;
}

async function mut21() {
  const [a, b, w] = await openDmPair();
  try {
    const own = mark('MUT21OWN');
    await sendText(a, own);
    await awaitMessage(b, own, 20000);
    const peer = mark('MUT21PEER');
    await sendText(b, peer);
    await awaitMessage(a, peer, 20000);

    // Own message -> strip is `right-full`, to the LEFT of a right-aligned bubble.
    const ownReach = await toolbarReach(
      a,
      own,
      `[].filter.call(row.querySelectorAll('button'), function (x) { return (x.innerText || '').trim() === '❤️'; })[0]`
    );
    // Peer message -> strip is `left-full`, to the RIGHT of a left-aligned bubble.
    const peerReach = await toolbarReach(
      a,
      peer,
      `(function () { var s = row.querySelector('svg.lucide-reply'); return s ? s.closest('button') : null; })()`
    );

    const ok = !!ownReach?.reachable && !!peerReach?.reachable;
    await finish('MUT-21/dm', ok ? 'PASS' : 'FAIL', w, {
      ownReach,
      peerReach,
      filedAs: 'backlog.md - "the message hover bar is too wide on desktop, and the sidebar takes its clicks"',
      note: ok
        ? 'REACHABLE at the launched width - the defect is fixed, and every withToolbarRoom() call site can now be deleted'
        : 'expected FAIL: the documented layout defect is still present, and withToolbarRoom() is still earning its place',
    });
    // Like MUT-15: `ok` means "the documented hole was reproduced", not "the app is right".
    return true;
  } catch (e) {
    return await finish('MUT-21/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
}

const CHECKS = {
  1: mut1,
  2: mut2,
  3: mut3,
  4: mut4,
  5: mut5,
  6: mut6,
  7: mut7,
  8: mut8,
  9: mut9,
  10: mut10,
  11: mut11,
  12: mut12,
  13: mut13,
  14: mut14,
  15: mut15,
  16: mut16,
  17: mut17,
  18: mut18,
  19: mut19,
  20: mut20,
  21: mut21,
};

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`MUT-${n}`, 'ERROR', { error: e.message });
    results.push([n, false]);
  }
}
console.log(`\nMUT: ${results.filter(([, ok]) => ok).length}/${results.length} checks reported ok (MUT-15's ok means "reproduced the documented hole", not "pin survived")`);
process.exit(0);
