#!/usr/bin/env node
/**
 * MUT-1..21 - message mutation (edit, delete, react, pin) on both transports.
 *
 * AND ON THE PHONE, since 2026-08-16. MUT-18 sat SKIPPED because every control here is resolved by
 * HOVERING a bubble and clicking `svg.lucide-*` in the desktop toolbar, and a touch screen has
 * neither a hover nor that toolbar - it raises `MessageMobileActions` on a 420 ms press.
 * `longPressBubble` and `tapSheetIcon` (chat.mjs) are that missing surface; `saveOpenEdit` below is
 * the second half of it, because a control reached AFTER a field has focus cannot be resolved by
 * coordinates at all while the soft keyboard is up.
 *
 * THE CENTRAL POINT OF THIS PHASE: every row that applies to both venues runs TWICE - once in the
 * DM (MLS transport, `messaging.ts` / `useMessaging.svelte.ts`) and once in the `Campagne de test`
 * channel (REST transport, `ChannelService.ts` / `useChannelWorkspaces.svelte.ts`). They look the
 * same on screen and are NOT the same code, which is exactly what MUT-6 vs MUT-8 and MUT-15 vs
 * MUT-16 exist to prove: a DM delete is a client-side tombstone with no server enforcement at all,
 * a channel delete is a server-authoritative hard row delete; a DM pin travels in the conversation's
 * own history, a channel pin is re-hydrated from the server on every open. Getting that wrong in
 * either direction is the whole risk this phase is checking for.
 *
 * READ OFF THE SOURCE, not guessed (the numbers and code paths are the whole check):
 *   - `MessageBubbleToolbar.svelte`: edit needs `isOwn && !hasMedia`; delete needs `isOwn ||
 *     canModerate`; `canModerate` (`MainChatPage.svelte` `canModerateSelectedChannel`) is
 *     `isSelectedChannel && ...` - i.e. ALWAYS false in a DM or group, by construction.
 *   - `useMessaging.svelte.ts` `handleDeleteMessage`/`handleEditMessage` check ownership on the
 *     SENDING device, which decides what to put on the wire and is therefore not a check at all.
 *     Both RECEIVING handlers re-check it against the identity MLS authenticated for the frame -
 *     `mutationIsAuthorised` (`systemMessageHandler.ts`) live, `replayMutationIsAuthorised`
 *     (`historySystemEvents.ts`) on replay. MUT-10 is what found that the second one was missing.
 *   - `pinStore.svelte.ts` + `historySystemEvents.ts`/`systemMessageHandler.ts`: a DM/group pin is
 *     an MLS system event carrying `at`, applied into a per-conversation last-write-wins register
 *     keyed by GROUP ID, where an `unpin` is a dated tombstone rather than a removal. It travels two
 *     ways - the frames themselves, and the whole register on every `history_bundle`, merged per
 *     message on `at`. A channel pin is fetched fresh from the server (`MainChatPage.svelte`
 *     `listPinnedMessageIds` -> `setPinnedSet`, which REPLACES the set) on every channel open.
 *   - `messaging.ts` `deleteMessage` -> `cancelOutboxMessage`: a delete is a CANCELLATION while the
 *     message is still queued, and only becomes a `delete_message` broadcast once the frame has
 *     left the device. MUT-19 is what found that it used to be only the second of those.
 *   - `useConversations.svelte.ts` `loadChannelHistory`: wipes the local channel message cache
 *     (`storage.deleteMessagesForConversation`) and REPLACES it wholesale from a fresh
 *     `channelService.listMessages` fetch whenever the 5-minute cache is stale or invalidated - and
 *     `deleteChannelMessage`/`handleChannelMessageDeleted` both call
 *     `invalidateChannelHistoryCache` right after a delete, so the NEXT open force-refetches and a
 *     hard-deleted row is simply absent from the server's answer.
 *   - `messageReactions.ts`: `MAX_DISTINCT_MESSAGE_REACTIONS = 15`, enforced client-side for DMs
 *     (`toggleMessageReaction` returns null past the cap) and server-side for channels
 *     (`service.toggleReaction` is authoritative, the client only applies optimistically).
 *   - `messaging.ts` `addReaction` + `reactionNotify.ts` `notifyReaction`: a
 *     `POST /api/mls/notify-reaction` fires if-and-only-if `targetMsg.senderId !== userId` - the
 *     author-only, never-the-reactor rule. `notifyReaction` is a leaf module ON PURPOSE: importing
 *     it from the channel side closed an import cycle that was entered at module scope.
 *
 * OBSERVATION IS PART OF EVERY CHECK HERE, and it was not until 2026-08-15. This file computed
 * twenty verdicts while reading no console line at all - the same fault READ shipped eight PASSes
 * under (rule 13 of testing-methodology). Both clients are now watched from BEFORE the setup
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
  longPressBubble,
  tapSheetIcon,
  sameAccountAs,
  until,
  COMPOSER,
  IS_MOVING_FN,
  stablePoint,
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
  const p = await stablePoint(
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
      return { x: x, y: y, moving: ${IS_MOVING_FN}(btn), name: (btn.getAttribute('aria-label') || btn.innerText || '').trim().slice(0, 40) };
    })())`
  );
  // The action row appears ON HOVER, so it is the likeliest target in the app to be aimed at while
  // it is still arriving. `stablePoint` polls through "not there yet" / "covered" / "moving" alike -
  // they are one animation seen at three moments - and only the timeout is a failure.
  if (p.timedOut) {
    throw new Error(
      `no settled .${iconClass} action on the row of ${textMatch} within 4s - last read: ${JSON.stringify(p.last)}`
    );
  }
  const { received } = await clickAtPoint(cx, p.x, p.y);
  // A click NOTHING received is the silent failure this exists to name. It is not retried here: the
  // caller decides, because for a reaction a second click TOGGLES rather than repeats.
  if (!received) {
    throw new Error(
      `the .${iconClass} click at ${p.x},${p.y} on the row of ${textMatch} was dispatched and nothing received it`
    );
  }
  return { ...p, received };
}

/** Clicks a reaction-emoji button (the quick strip OR the picker's "recent" panel - both render the
 *  bare emoji as `button.innerText`, unlike every other action which carries a localised label). */
async function clickReactionEmoji(cx, textMatch, emoji) {
  await hoverBubble(cx, textMatch);
  const p = await stablePoint(
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
      return { x: x, y: y, moving: ${IS_MOVING_FN}(btn) };
    })())`
  );
  // THE PICKER OPENS WITH AN ANIMATION, which is what made this the first helper to be caught by it:
  // `the 🎉 click was taken by "EMOJI-PICKER" (target was ANIMATING when measured)`. Waiting for the
  // emoji to be still is the whole fix - a closed picker, a covered button and a moving one are the
  // same panel at three moments, so all three are polled and only the timeout is a failure.
  if (p.timedOut) {
    throw new Error(
      `no settled ${emoji} reaction on the row of ${textMatch} within 4s - last read: ${JSON.stringify(p.last)}`
    );
  }
  const { received } = await clickAtPoint(cx, p.x, p.y);
  // THE EMOJI IS ITS OWN BUTTON LABEL, so unlike the icon helper this one can assert the click was
  // taken by the RIGHT control and not merely by some control. A reaction click is a toggle, so a
  // miss retried is a reaction removed - hence the throw, and no retry.
  if (!received) {
    throw new Error(`the ${emoji} click at ${p.x},${p.y} on the row of ${textMatch} was dispatched and nothing received it`);
  }
  if (received.btn !== emoji && received.text !== emoji) {
    // NO "was it animating" HERE ANY MORE, and its absence is the point: `stablePoint` only returns
    // a settled point, so that question can now only be answered one way and answers nothing. A miss
    // reaching this line is therefore a motion the animation proof does not cover - report the point
    // and what took it, and do not offer a cause the code can no longer distinguish.
    throw new Error(
      `the ${emoji} click at ${p.x},${p.y} was taken by "${received.btn || received.tag}" - ` +
        `the row moved under a point that had settled`
    );
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

/**
 * Every emoji the row currently OFFERS as a one-click button: the quick strip, plus the picker's
 * "recent" panel when it is open.
 *
 * It exists so a failure can name what IS there. `clickReactionEmoji` throws "no quick-reaction X on
 * the row", which is the same sentence for a picker that never opened and for a picker that opened
 * with the wrong recent list - and those two want opposite fixes. Short labels only: every other
 * control on the row carries a localised word, and an emoji does not.
 */
async function offeredEmojis(cx, textMatch) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = ${paneExpr()};
      var findRow = ${FIND_ROW_FN};
      var row = findRow(pane, ${JSON.stringify(textMatch)});
      if (!row) return [];
      return [].map.call(row.querySelectorAll('button'), function (b) {
        return (b.innerText || '').trim();
      }).filter(function (t) { return t.length > 0 && t.length <= 8; });
    })())`
  );
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

/**
 * Polls the row's badges on `cx` until `predicate` holds, and returns `{ms, badges}` - `ms` null
 * past the deadline, with the badges as last seen so the failure carries its own evidence.
 *
 * `reactAndConfirm` does this for the client that CLICKED; this is the peer's half, and MUT-11 had
 * neither. Its fixed 300 ms sleeps made "the reaction never crossed" and "it has not repainted yet"
 * the same observation, and a DM reaction is a durable-outbox round trip, not a local repaint: the
 * check flapped once on 😂 and passed on the next run with no code between the two.
 */
async function awaitBadges(cx, textMatch, predicate, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const badges = (await reactionBadges(cx, textMatch)) || [];
    if (predicate(badges)) return { ms: Date.now() - started, badges };
    if (Date.now() - started > timeoutMs) return { ms: null, badges };
    await sleep(150);
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

/**
 * Leaves the message UNPINNED, and says so if it could not - never silently.
 *
 * THE CAMPAIGN LEFT A PIN STANDING ON THE PRODUCTION CONVERSATION, which the user found before this
 * did. Both pin checks do call the unpin, but each wrote it as `clickPinIcon(...).catch(() => {})`
 * INSIDE the try: so a click the layout made impossible was swallowed without a word, and a check
 * that threw earlier skipped the cleanup entirely. A best-effort cleanup that cannot report is
 * indistinguishable from no cleanup at all - the whole reason this file is not allowed to swallow a
 * branch. Called from `finally`, it also runs on the paths that failed.
 *
 * @returns {Promise<string|null>} null when the message ends up unpinned, else why it did not.
 */
async function ensureUnpinned(cx, textMatch) {
  try {
    const s = await pinState(cx, textMatch);
    if (s === null) return `no pin control on the row of ${textMatch} - cannot confirm it is unpinned`;
    if (s === 'unpinned') return null;
    await clickBubbleIcon(cx, textMatch, 'lucide-pin-off');
    await sleep(400);
    const after = await pinState(cx, textMatch);
    return after === 'unpinned' ? null : `still ${after} after clicking unpin`;
  } catch (e) {
    return `unpin failed: ${e.message}`;
  }
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
  const confirmed = await realClick(cx, 'text=Supprimer');
  try {
    await until(cx, `!document.querySelector('[role="dialog"]')`, 5000);
  } catch {
    // THE OPEN WAIT ABOVE NAMES ITS CAUSE AND THIS ONE USED TO THROW A BARE TIMEOUT - so when MUT-7
    // and MUT-8 both died here on 2026-08-16 (pass 2 of 5, pass 1 clean throughout) nothing in the
    // run could separate the three causes, and by the time a probe looked the modal had closed on
    // its own. They want opposite fixes: a confirm click that resolved to the WRONG element is the
    // harness (`RESOLVE('text=')` searches the whole document - the modal only wins because the
    // backdrop makes every other candidate fail the hit-test, which is protection by accident); a
    // dialog still standing with the message already gone is a UI that lingers past its own work;
    // a dialog standing with the message still there is the delete itself being slow.
    // WHAT IS AT THE AIMED POINT NOW is the half the recorder cannot give: it names the element
    // that TOOK the click, and the question this leaves open is what was sitting on top of the
    // button to take it. Read at the coordinates that were actually dispatched.
    const seen = JSON.parse(
      await evaluate(
        cx,
        `JSON.stringify((function () {
          var d = document.querySelector('[role="dialog"]');
          var pane = ${paneExpr()};
          var ax = ${Number(confirmed?.x) || 0}, ay = ${Number(confirmed?.y) || 0};
          var at = document.elementFromPoint(ax, ay);
          // The button the click was MEANT for, found the way a user finds it: the confirm control
          // inside the standing dialog. Its rect NOW against the point that was dispatched is the
          // discriminator - a miss of a few px means the target moved between hit-test and dispatch
          // (the panel flies in over 220ms and the button carries hover:-translate-y-0.5), while a
          // point far outside it means the resolver picked a different element entirely.
          var want = d ? [].slice.call(d.querySelectorAll('button')).filter(function (b) {
            return (b.innerText || '').trim() === 'Supprimer';
          })[0] : null;
          var r = want ? want.getBoundingClientRect() : null;
          return {
            dialogStillOpen: !!d,
            dialogText: d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : null,
            messageStillOnScreen: !!pane && pane.innerText.indexOf(${JSON.stringify(textMatch)}) !== -1,
            nowAtAimedPoint: at
              ? {
                  tag: at.tagName,
                  cls: (at.className && at.className.baseVal !== undefined ? at.className.baseVal : String(at.className || '')).slice(0, 90),
                  text: (at.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
                  inDialog: !!(d && d.contains(at)),
                }
              : null,
            confirmButtonNow: r
              ? {
                  rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
                  containsAimedPoint: ax >= r.left && ax <= r.right && ay >= r.top && ay <= r.bottom,
                  dyFromCentre: Math.round(ay - (r.top + r.bottom) / 2),
                  dxFromCentre: Math.round(ax - (r.left + r.right) / 2),
                }
              : null,
            candidatesInDocument: [].filter.call(document.querySelectorAll('button'), function (b) {
              return (b.innerText || '').trim() === 'Supprimer' && (b.offsetWidth || b.offsetHeight);
            }).length,
          };
        })())`
      )
    );
    throw new Error(
      `the delete-confirmation dialog was still open 5s after the confirm click on ${textMatch} - ` +
        `aimed at <${confirmed?.tag}> "${confirmed?.text}" at ${confirmed?.x},${confirmed?.y}; ` +
        `the click was TAKEN BY ${JSON.stringify(confirmed?.received)}; ` +
        `and the page shows ${JSON.stringify(seen)}`
    );
  }
}

/**
 * Fills the ALREADY OPEN inline edit form and saves it.
 *
 * Opening the form is the caller's half because the two platforms do it differently and only
 * differently: the desktop hover toolbar's pencil, or the phone's long-press action sheet. What
 * follows is identical - `MessageEditForm.svelte` is one component - so it is written once.
 *
 * The textarea and the Save button carry no stable hook (see header comment); the textarea is at
 * least uniquely locatable (only one message can be in edit mode at a time), so only Save needs
 * text.
 */
async function fillAndSaveEdit(cx, newText) {
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
  await saveOpenEdit(cx);
  await until(cx, `!${taExpr}`, 5000);
}

/**
 * Saves the OPEN edit form by clicking the button inside the form itself - on BOTH platforms.
 *
 * NEITHER `realClick` NOR `activate` WORKS ON THE PHONE, and the reason is worth keeping because it
 * will recur for every mobile control reached after a field has focus. Both resolve through
 * `RESOLVE`,
 * whose last filter is a hit test at the element's centre - and a hit test is a coordinate test.
 * With the soft keyboard up, Android's VISUAL viewport is shorter than the LAYOUT viewport that
 * `getBoundingClientRect` reports, so the centre of a control that is plainly on screen belongs to
 * something else. `activate` then answers `no element to activate: text=Enregistrer` about a button
 * a probe had just measured at 77x26 with its label spelt exactly that way.
 *
 * Skipping the hit test is safe HERE and would not be in general: only one message can be in edit
 * mode at a time, so the form is unique on the page and there is no second candidate for the click
 * to land on - which is the only thing the hit test was defending against.
 *
 * IT IS THE DESKTOP PATH TOO, and not for symmetry. `realClick` went on to fail MUT-2 with
 * `no stable element for selector: text=Enregistrer` on a browser, having passed the same step
 * minutes earlier: `stableCentreOf` samples the geometry twice and the form animates in, so the
 * check was racing a CSS transition for no benefit. One path, no coordinates, no race.
 */
async function saveOpenEdit(cx) {
  const outcome = await evaluate(
    cx,
    `(function () {
      var ta = ${paneExpr()}.querySelector('textarea');
      if (!ta) return 'no edit form is open';
      var form = ta.closest('form') || ta.parentElement.parentElement;
      var all = [].slice.call(form.querySelectorAll('button'));
      var btn = all.filter(function (b) {
        return (b.innerText || '').trim().toLowerCase() === 'enregistrer';
      })[0];
      if (!btn) {
        return 'no save button in the edit form - it offers [' +
          all.map(function (b) { return (b.innerText || '').trim(); }).join(' ') + ']';
      }
      btn.click();
      return 'ok';
    })()`
  );
  if (outcome !== 'ok') throw new Error(String(outcome));
}

/** Desktop inline edit: the hover toolbar's pencil, then the shared form. */
async function editBubble(cx, textMatch, newText) {
  await clickBubbleIcon(cx, textMatch, 'lucide-pencil');
  await fillAndSaveEdit(cx, newText);
}

/**
 * The phone's inline edit: long press -> the action sheet's pencil -> the same form.
 *
 * There is no hover on a touch screen and no toolbar to hover, which is why MUT-18 was SKIPPED for
 * days: not because A1 was unreachable - it never was - but because every control in this file was
 * resolved through a surface the phone does not have.
 */
async function editBubbleMobile(cx, textMatch, newText) {
  await longPressBubble(cx, textMatch);
  await tapSheetIcon(cx, 'lucide-pencil');
  await fillAndSaveEdit(cx, newText);
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

/**
 * Polls a HARNESS-side predicate until it holds, returning the elapsed ms or throwing.
 *
 * `until` (cdp.mjs) evaluates a predicate inside the page, which several of the reads here cannot
 * be expressed as - `pinState` is three queries and a decision. Waiting on the CONDITION rather
 * than on a fixed delay is the rule either way: a sleep is wrong when it is short and wasteful when
 * it is long, and the message here can take a reconnect to arrive.
 */
async function pollFor(fn, timeoutMs, what, stepMs = 250) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(stepMs);
  }
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
    await deleteBubble(deletingCx, target);
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

  const has = (emoji) => (badges) => badges.some((r) => sameEmoji(r.emoji, emoji));
  const lacks = (emoji) => (badges) => !badges.some((r) => sameEmoji(r.emoji, emoji));
  const countIs = (emoji, n) => (badges) =>
    badges.some((r) => sameEmoji(r.emoji, emoji) && r.count === n);

  await clickReactionEmoji(a, marker, '❤️'); // react
  const first = await awaitBadges(b, marker, has('❤️'));

  await clickReactionEmoji(a, marker, '❤️'); // un-react (toggle)
  const un = await awaitBadges(b, marker, lacks('❤️'));

  await clickReactionEmoji(a, marker, '❤️'); // re-react
  await awaitBadges(b, marker, has('❤️'));

  await clickReactionEmoji(b, marker, '❤️'); // second user, same emoji
  await awaitBadges(b, marker, countIs('❤️', 2));

  await clickReactionEmoji(a, marker, '😂'); // same user, second distinct emoji
  const last = await awaitBadges(b, marker, has('😂'));

  const afterFirstReact = first.badges;
  const afterUnreact = un.badges;
  const final = last.badges;
  const heart = final.find((r) => sameEmoji(r.emoji, '❤️'));
  const laugh = final.find((r) => sameEmoji(r.emoji, '😂'));
  const ok =
    first.ms !== null &&
    un.ms !== null &&
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
    // A slow badge and a lost one are now different reports. MUT-11/dm failed once on the 😂 leg
    // with `final` holding only the heart, and passed on the very next run: the peer's repaint had
    // simply not happened inside a fixed 300 ms.
    peerDelaysMs: { firstReact: first.ms, unreact: un.ms, secondEmoji: last.ms },
  });
}

async function mut11() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await mut11Body(a, b, w, 'dm');
  } catch (e) {
    await finish('MUT-11/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await mut11Body(a, b, w, 'channel');
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

  // THE SEED GOES IN BEFORE THE MESSAGE EXISTS, and the old comment here was wrong in a way that
  // cost a false PASS. `MessageEmojiPicker` is instantiated by every BUBBLE (`MessageBubble.svelte`
  // renders it unconditionally and only flips its `visible` prop), so its `onMount` reads
  // `canari_recent_emojis` the instant the row renders - not when the picker is first opened. A seed
  // written after `sendText` therefore cannot reach the row this check is about, ever.
  //
  // What that produced: MUT-12/dm threw on the first picker emoji, deterministically, while
  // MUT-12/channel PASSED - because the DM leg threw before its own cleanup and left the seed in
  // localStorage, where the channel leg's bubble picked it up on mount. The channel was passing on
  // the previous check's litter, which is worse than failing: on a fresh profile both legs fail.
  await evaluate(a, `localStorage.setItem('canari_recent_emojis', ${JSON.stringify(JSON.stringify(RECENT_SEED))})`);

  await sendText(a, marker);
  await awaitMessage(b, marker, 25000);

  // WHICH emoji landed, one by one. The picker is re-asserted per iteration rather than once before
  // the loop: `ensurePickerOpen` is idempotent on the picker's own state, so a panel that closes on
  // selection is handled by construction instead of by luck - and if it does close, the reopen is
  // recorded rather than being the silent difference between an emoji that landed and one that
  // could not even be aimed at.
  const missing = [];
  const delays = [];
  const react = async (emoji, viaPicker) => {
    if (viaPicker) {
      await ensurePickerOpen(a, marker);
      // WHAT IS ACTUALLY OFFERED, not "not found". `clickReactionEmoji`'s own message cannot tell a
      // closed picker from an open one with the wrong recent list, and those want opposite fixes.
      const offered = await offeredEmojis(a, marker);
      if (!offered.some((t) => sameEmoji(t, emoji))) {
        throw new Error(
          `the picker is open on ${marker} and does not offer ${emoji} - the row offers [${offered.join(' ')}]`
        );
      }
    }
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

/**
 * `mut12Body` with the seed guaranteed removed, however it exits.
 *
 * THE LITTER IS THE BUG HERE, not the throw: a seed left behind by a leg that failed is read on
 * mount by the NEXT leg's bubble, which is exactly how MUT-12/channel passed while MUT-12/dm could
 * not even find its first picker emoji. A cleanup that only runs on the happy path is not a cleanup.
 */
async function mut12Guarded(a, b, w, idSuffix) {
  try {
    return await mut12Body(a, b, w, idSuffix);
  } finally {
    await evaluate(a, `localStorage.removeItem('canari_recent_emojis')`).catch(() => {});
  }
}

async function mut12() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await mut12Guarded(a, b, w, 'dm');
  } catch (e) {
    await finish('MUT-12/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await mut12Guarded(a, b, w, 'channel');
  } catch (e) {
    await finish('MUT-12/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
  return dmOk && chOk;
}

// ── MUT-13: a reaction notifies the message AUTHOR only, never the reactor [both] ──────────────

/** The `/api/mls/notify-reaction` requests this client has made since its watcher was armed. */
const notifyPosts = (cx) =>
  cx.events.filter(
    (e) =>
      e.method === 'Network.requestWillBeSent' &&
      String(e.params?.request?.url || '').includes('/api/mls/notify-reaction')
  );

/** Waits for one more notify POST than `baseline`; ms, or null past the deadline. */
async function awaitNotifyPost(cx, baseline, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (notifyPosts(cx).length > baseline) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}

/**
 * BOTH VENUES RUN THIS, and until 2026-08-16 only the DM did - because until this session only the
 * DM had the code. A channel reaction reached every member as a `channel.reaction` broadcast and
 * reached no phone at all; `useChannelWorkspaces.svelte.ts` `toggleChannelReaction` now calls the
 * same `notifyReaction` under the same author-only rule, so the check that proves the rule must run
 * on the same two venues as every other row in this phase.
 *
 * The two call sites are NOT symmetric in timing, and the windows below are sized on the slower:
 * the DM enqueues into the outbox and fires immediately, the channel fires only once
 * `service.toggleReaction` has RESOLVED and the actor's display name has been looked up.
 */
async function mut13Body(a, b, w, idSuffix) {
  const marker = mark('MUT13');
  await sendText(a, marker); // authored by a (W1)

  // `Network.enable` is not repeated here: `watch()` armed it on both clients before the setup
  // navigated, and `cx.events` has been accumulating since. Re-enabling would read as "the buffer
  // starts here", which is exactly what it does NOT do.
  await awaitMessage(b, marker, 20000);

  // b, who is NOT the author, reacts: the author must be told.
  const beforeReactor = notifyPosts(b).length;
  await clickReactionEmoji(b, marker, '❤️');
  const reactorMs = await awaitNotifyPost(b, beforeReactor);

  // a reacts to THEIR OWN message: nobody must be told.
  const beforeSelf = notifyPosts(a).length;
  await clickReactionEmoji(a, marker, '👍');

  // AN ABSENCE CAN ONLY BE BOUNDED - BUT THE BOUND COMES FROM THE MEASUREMENT, NOT FROM A GUESS.
  //
  // This was `sleep(6000)`, a number sized on nothing: too small and a slow POST would pass as
  // silence, too large and every run pays six seconds to observe nothing. The same run has just
  // measured how long this exact request takes when it IS made (`reactorMs`, typically ~155 ms), so
  // that is the honest bound - generously multiplied, with a floor for the case where the reactor
  // leg itself was suspiciously fast. And the wait ENDS EARLY on the event it is watching for: a
  // notify POST appearing is a failure, and there is nothing to wait for once it has appeared.
  const silenceWindowMs = Math.max(1500, (reactorMs ?? 500) * 6);
  const selfDeadline = Date.now() + silenceWindowMs;
  while (Date.now() < selfDeadline) {
    if (notifyPosts(a).length > beforeSelf) break; // the failure, seen the moment it happens
    await sleep(100);
  }
  const selfHits = notifyPosts(a).length - beforeSelf;

  const ok = reactorMs !== null && selfHits === 0;

  // Cleanup, inside the window - see MUT-11.
  await clickReactionEmoji(b, marker, '❤️').catch(() => {});
  await clickReactionEmoji(a, marker, '👍').catch(() => {});

  return await finish(`MUT-13/${idSuffix}`, ok ? 'PASS' : 'FAIL', w, {
    reactorNotifyMs: reactorMs,
    selfReactFiredNotify: selfHits,
    // The window the silence was observed over, derived from this run's own measurement of the same
    // request. A reader can judge whether the absence means anything; a bare `0` could not be judged.
    silenceWindowMs,
    note:
      'this verifies only the CLIENT-SIDE precondition (messaging.ts addReaction and ' +
      'useChannelWorkspaces toggleChannelReaction: POST /api/mls/notify-reaction iff the author is ' +
      'someone else). Whether the push actually reaches the author\'s DEVICE is not observable from a ' +
      'browser - that half is owed to the NOTIF phase and is NOT claimed passed here.',
  });
}

async function mut13() {
  let [a, b, w] = await openDmPair();
  let dmOk = false;
  try {
    dmOk = await mut13Body(a, b, w, 'dm');
  } catch (e) {
    await finish('MUT-13/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }

  [a, b, w] = await openChannelPair();
  let chOk = false;
  try {
    chOk = await mut13Body(a, b, w, 'channel');
  } catch (e) {
    await finish('MUT-13/channel', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(a, b);
  }
  return dmOk && chOk;
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

// ── MUT-15: a DM pin reaches a device that was OFFLINE when it was placed [DM] ─────────────────

async function mut15() {
  const [a, b, w] = await openDmPair();
  // `a` is the client cut below, so only ITS window is narrowed by the outage - see observe().
  const cut = { W1: ignoringOfflineCut };
  const marker = mark('MUT15');
  try {
    await sendText(a, marker);
    await awaitMessage(b, marker, 25000);

    // THE DEVICE THAT MISSES THE PIN IS CUT, NOT REWOUND. The first version of this check dropped
    // `a`'s pin record and restored its `history_last_stream_id` / `history_seen_cipher` snapshot,
    // to make the replay re-read the frame. That state is UNREACHABLE in production: MLS forward
    // secrecy spends a generation's secret at the first successful decrypt, so a device whose
    // ratchet has consumed the frame cannot decrypt it again whatever localStorage says. The check
    // was therefore asking MLS to do the one thing it exists to refuse, and reading the refusal as
    // a product defect. A device that genuinely lacks a pin is one that was NOT THERE when the
    // frame was written - which is an outage, and is what this now builds.
    await setOffline(a, true);

    // THE PIN IS PLACED BY THE PEER, and that is not a detail. MLS gives a device no echo of its
    // OWN frames, so a device can never recover a pin it placed itself from the log; pinning from
    // `b` makes `a` a RECEIVER of the frame, which is the half a browser here can measure.
    await clickPinIcon(b, marker);

    // THE PRECONDITION, ASSERTED AND NOT ASSUMED. Without this read the poll below is satisfied by
    // a pin that crossed BEFORE the cut, and the check passes while having exercised no recovery
    // at all - the shape that made TYPE-4 meaningless for five runs (testing-methodology, rule 7).
    await sleep(2500);
    const stateWhileOffline = await pinState(a, marker);

    await setOffline(a, false);
    const recoveredMs = await pollFor(
      async () => (await pinState(a, marker)) === 'pinned',
      30000,
      'the pin to reach a once it is back'
    ).then((ms) => ms, () => null);

    const ok = stateWhileOffline !== 'pinned' && recoveredMs !== null;
    return await finish(
      'MUT-15/dm',
      ok ? 'PASS' : 'FAIL',
      w,
      {
        stateWhileOffline,
        recoveredMs,
        unpinFailure: await ensureUnpinned(b, marker),
        covers: 'a device that was absent when the pin was placed converges once it is back',
        doesNotCover:
          'the archive-replay and history_bundle halves - both need the frame to have left the server queue (retention) or a real fresh enrolment, see device-verification L',
      },
      cut
    );
  } catch (e) {
    return await finish('MUT-15/dm', 'ERROR', w, { error: e.message }, cut);
  } finally {
    await setOffline(a, false).catch(() => {});
    closeAll(a, b);
  }
}

// ── MUT-16: a channel pin DOES survive - the server re-hydrates it [Channel] ───────────────────

async function mut16() {
  let [a, b, w] = await openChannelPair();
  // Declared OUTSIDE the try so `finally` can name the message it must leave unpinned - the cleanup
  // is needed precisely on the paths where the body did not reach its own end.
  const marker = mark('MUT16');
  try {
    await sendText(a, marker);
    await awaitMessage(b, marker, 25000);

    const before = await pinStoreSnapshot(a);
    await clickPinIcon(a, marker);
    await sleep(400);
    const after = await pinStoreSnapshot(a);
    const key = diffPinKey(before, after);

    // A channel pin is SERVER state, so dropping the local record and re-opening is a legitimate
    // fresh-device simulation here where the same trick is not one for a DM (see MUT-15): nothing
    // has to be decrypted twice. `MainChatPage.svelte`'s `$effect` calls
    // `channelService.listPinnedMessageIds` + `setPinnedSet` (which REPLACES the set, not merges)
    // every time a channel is opened, and that is what this reads back.
    await restorePinKey(a, key, before[key]);
    [a] = await Promise.all([openChannel(a, VENUE.community, VENUE.channel)]).then(() => [a]);
    await until(a, `${paneExpr()}.innerText.indexOf(${JSON.stringify(marker)}) !== -1`, 15000);

    const stateAfterFreshLoad = await pinState(a, marker);
    const ok = stateAfterFreshLoad === 'pinned';
    return await finish('MUT-16/channel', ok ? 'PASS' : 'FAIL', w, {
      stateAfterFreshLoad,
      unpinFailure: await ensureUnpinned(a, marker),
      contrastNote:
        'compare against MUT-15/dm: a channel pin is re-hydrated from the server on every open, a DM pin has to travel end to end',
    });
  } catch (e) {
    return await finish('MUT-16/channel', 'ERROR', w, { error: e.message });
  } finally {
    // IN `finally`, because a channel pin is SERVER-side: left standing it is visible to every
    // member of the community, and the paths that throw are exactly the ones that pinned and then
    // could not finish. Idempotent, so running it twice on the success path costs one DOM read.
    const leftover = await ensureUnpinned(a, marker);
    if (leftover) console.log(`[MUT-16] CLEANUP FAILED, a pin is standing on the channel: ${leftover}`);
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

// ── MUT-18: two devices of the SAME user edit the same message at once [DM, W1 + A1] ───────────

/**
 * ARMED AT LAST, and what unblocked it was a helper, not the cable.
 *
 * This carried a SKIP whose reason was FALSE - it said A1 was off adb, while SESSION STATE had said
 * the opposite for weeks. The real obstacle was that every mutation helper in this file resolves its
 * control by HOVERING the bubble and clicking `svg.lucide-*` in the desktop toolbar, and the phone
 * has neither: it raises `MessageMobileActions` on a 420 ms press. `longPressBubble` + `tapSheetIcon`
 * in `chat.mjs` are that missing surface, and this is their first user.
 *
 * WHAT IT MEASURES. Both devices hold the OWNER's account, so both are allowed to edit, and
 * `handleEditMessage` checks ownership on the SENDING device only (see MUT-10): two `edit_message`
 * system events for one `messageId` therefore both go out, and every receiver applies whichever it
 * gets, in the order it gets it. The risk is not that one wins - one must - it is that the two
 * devices settle on DIFFERENT winners and stay that way, with the peer holding a third answer.
 *
 * So the verdict is CONVERGENCE, not a particular text: all three clients must show the same body,
 * and it must be one of the two edits rather than the original or a merge of both.
 *
 * The row is addressed by `#msg-<id>` from here on. An edit rewrites the body, so the text this
 * check starts from stops naming the row the moment the first edit lands.
 */
async function mut18() {
  const [w1, w2] = await Promise.all([client(W1, MATCH), client(W2, MATCH)]);
  const probe = await sameAccountAs(w1, PORTS.A1, 'tauri.localhost');
  if (!probe.ok) {
    record('MUT-18/dm', 'SKIPPED', { reason: probe.why, checked: true });
    closeAll(w1, w2);
    return true;
  }
  const a1 = probe.cx;
  const w = { W1: await watch(w1, 'W1'), W2: await watch(w2, 'W2'), A1: await watch(a1, 'A1') };
  try {
    await openDM(w1, PEER_NAME);
    await openDM(w2, OWNER_NAME);
    await openDM(a1, PEER_NAME); // A1 holds the owner account, so it looks for the peer, as W1 does

    const marker = mark('MUT18');
    await sendText(w1, marker);
    await awaitMessage(a1, marker, 30000);
    await awaitMessage(w2, marker, 30000);

    // Taken BEFORE either edit - see the header: after one lands, `marker` names nothing.
    const row = await bubbleRowLocator(w1, marker);
    if (!row) throw new Error(`no #msg-<id> locator for ${marker} on W1`);

    const fromW1 = `${marker}-W1`;
    const fromA1 = `${marker}-A1`;

    // AT ONCE, as far as two transports can be: both edits are started without awaiting the other,
    // and each failure is kept rather than collapsing the pair into one rejection - a check that
    // cannot say WHICH device failed to edit says nothing about a crossing of two edits.
    const [w1Edit, a1Edit] = await Promise.allSettled([
      editBubble(w1, row, fromW1),
      editBubbleMobile(a1, row, fromA1),
    ]);

    // CONVERGENCE IS THE EVENT, so it is what is waited for - there is no interval to guess at.
    //
    // This was a 15 s wait for either edit to appear on W1 followed by `sleep(3000)` to give a
    // later-arriving edit room to overwrite an earlier one. Both halves were wrong in the two ways a
    // fixed delay always is: 3 s is a guess that can be short (a slow peer diverges and the check
    // calls it converged) and is wasted every time it is long, which is nearly always - the observed
    // spread is under half a second. The condition below is exactly what the verdict asserts, so
    // reaching it IS the finish line and the deadline only bounds the failure.
    let bw1 = null;
    let ba1 = null;
    let bw2 = null;
    let texts = [];
    let converged = false;
    const settledAt = Date.now();
    const CONVERGENCE_DEADLINE_MS = 20000;
    for (;;) {
      [bw1, ba1, bw2] = await Promise.all([
        bubbleBody(w1, row),
        bubbleBody(a1, row),
        bubbleBody(w2, row),
      ]);
      texts = [bw1, ba1, bw2].map((b) => (b ? b.text : null));
      converged =
        texts.every((t) => t !== null && t === texts[0]) &&
        (texts[0].includes(fromW1) || texts[0].includes(fromA1));
      if (converged || Date.now() - settledAt > CONVERGENCE_DEADLINE_MS) break;
      await sleep(200);
    }
    const settled = converged ? Date.now() - settledAt : null;
    converged = texts.every((t) => t !== null && t === texts[0]);
    const winnerIsAnEdit =
      converged && (texts[0].includes(fromW1) || texts[0].includes(fromA1));

    const ok =
      w1Edit.status === 'fulfilled' &&
      a1Edit.status === 'fulfilled' &&
      settled !== null &&
      converged &&
      winnerIsAnEdit;

    return await finish('MUT-18/dm', ok ? 'PASS' : 'FAIL', w, {
      w1EditError: w1Edit.status === 'rejected' ? String(w1Edit.reason?.message || w1Edit.reason) : null,
      a1EditError: a1Edit.status === 'rejected' ? String(a1Edit.reason?.message || a1Edit.reason) : null,
      winner: converged ? (texts[0].includes(fromW1) ? 'W1' : texts[0].includes(fromA1) ? 'A1' : 'neither') : null,
      convergedInMs: settled,
      bodies: { W1: bw1, A1: ba1, W2: bw2 },
      note:
        'the verdict is CONVERGENCE, not which edit won: both devices hold the same account and ' +
        'ownership is checked only on the sending device, so both edit_message events are legitimate ' +
        'and the receiver applies whichever arrives.',
    });
  } catch (e) {
    return await finish('MUT-18/dm', 'ERROR', w, { error: e.message });
  } finally {
    closeAll(w1, w2, a1);
  }
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

    // THE MESSAGE ID, TAKEN WHILE THE BUBBLE STILL CARRIES THE MARKER. The sender-side half of this
    // check cannot be read from the pane: a tombstone replaces the text, so the marker is absent
    // whether the row was dropped or kept, and the pane answers the same in both. The id is the only
    // handle that survives the deletion, and it has to be taken BEFORE it.
    const localId = await evaluate(
      a,
      `(function () {
         for (const el of document.querySelectorAll('[id^="msg-"]'))
           if ((el.innerText || '').indexOf(${JSON.stringify(marker)}) !== -1) return el.id.slice(4);
         return '';
       })()`
    );

    // Still offline: `handleDeleteMessage` is a pure local Svelte action, independent of
    // connectivity. Since 2026-08-16 `deleteMessage` asks the outbox FIRST - `cancelPending` drops
    // the queued entry and answers whether the frame is still on this device - and enqueues the
    // `delete_message` event only when it is not. Offline, with the entry never flushed, the
    // withdrawal is the path taken and NOTHING should reach the wire.
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

    // AND THE SENDER MUST NOT KEEP A ROW EITHER. Withdrawing left a tombstone behind until
    // 2026-08-16: `deleteMessage` knew it had withdrawn and returned nothing, so the caller wrote
    // `isDeleted` in both cases and the sender kept a durable row for a message no other device had
    // ever received. `recon.mjs` reads exactly that as a loss, and did - four of them, every one
    // manufactured by this check. The store is asked, not the pane, because the pane cannot tell a
    // dropped row from a tombstone.
    const senderKeptRow = localId
      ? await evaluate(
          a,
          `(async function () {
             const open = (n) => new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); setTimeout(() => res(null), 4000); });
             const d = (await indexedDB.databases()).filter((x) => x.name.indexOf('CanariDB_') === 0 && x.name.indexOf('Mls') === -1)[0];
             if (!d) return 'no-store';
             const db = await open(d.name);
             if (!db || !db.objectStoreNames.contains('messages')) return 'no-store';
             return await new Promise((res) => {
               const rq = db.transaction('messages', 'readonly').objectStore('messages').get(${JSON.stringify(localId)});
               rq.onsuccess = () => res(rq.result ? 'kept' : 'gone');
               rq.onerror = () => res('unreadable');
             });
           })()`
        )
      : 'unknown';

    // `everSawOriginal` IS THE ASSERTION AGAIN, AND THAT IS THE POINT OF THE FIX.
    //
    // It was demoted to evidence while the defect stood, because the row was a coin toss: the text
    // and the `delete_message` chasing it sat in the same outbox and flushed back to back, so
    // whether the peer painted the original for one frame before the tombstone landed was
    // scheduling this check does not control - measured `false` then `true` within an hour on the
    // same bundle, with no code in between. A verdict that flaps says nothing about the app.
    //
    // There is no race left to lose: the queued entry is WITHDRAWN, so nothing is sent and there is
    // nothing to take back. A single sighting of the original text now means the withdrawal did not
    // hold, which is a defect and not a scheduling accident - so it is red. The settled state stays
    // asserted beside it: the two together separate "never sent" from "sent and then repaired".
    // `unknown` is not a pass: it means the id could not be taken, so the sender-side half was never
    // asked. A check that cannot establish its own precondition says so rather than reporting green.
    const ok = !everSawOriginal && !finalHasOriginal && senderKeptRow === 'gone';
    return await finish(
      'MUT-19/dm',
      ok ? 'PASS' : 'FAIL',
      w,
      {
        renderedLocally,
        peerSawItWhileSenderOffline,
        everSawOriginal,
        finalHasOriginal,
        senderKeptRow,
        note: everSawOriginal
          ? 'THE WITHDRAWAL DID NOT HOLD: the peer saw the original text, so the queued entry reached the wire despite being deleted before the radio returned'
          : senderKeptRow === 'gone'
            ? 'the message was withdrawn from the queue and never sent - no peer saw it, and the sender kept no row for it'
            : `the peer is clean but the SENDER still holds the row (${senderKeptRow}) - a message no other device has, which reconciliation reports as a loss`,
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

// ── MUT-21: the hover toolbar stays inside the pane, at the width the report came from [DM] ────
//
// IT WAS WRITTEN TO FAIL AND IT NOW GUARDS THE FIX. The strip used to be positioned `right-full`,
// entirely outside the bubble, with nothing bounding it by the pane - so at the width these browsers
// launch at (958 px) it was laid out 69 px INTO the sidebar and `elementFromPoint` at the heart
// button's own centre returned a conversation row. Five checks whose subject is mutation could not
// click a reaction at all; each ran inside a viewport override, and this check existed to give that
// override an expiry. It PASSED on 2026-08-15 against the fix, the overrides were deleted the same
// hour, and what is left is a regression guard.
//
// It runs at the LAUNCHED width on purpose - a campaign that quietly widens its own viewport stops
// measuring what users have - and it measures both directions, because they are not symmetric: an
// own message hangs the strip to the left of a right-aligned bubble, a peer message to the right of
// a left-aligned one, and only the first ever reached the sidebar.

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
        ? undefined
        : 'REGRESSION: the strip has left the pane again - see the fix in MessageBubbleToolbar.svelte, which anchors it above the bubble on its outer edge precisely so bubble width cannot push it out',
    });
    // The strip is FIXED (`8e55aca8`), so this row is an ordinary regression guard: it reports its
    // own verdict. It used to return `true` unconditionally, from the days when it held a hole
    // open - which would have hidden the strip escaping the pane again behind a green tally.
    return ok;
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
console.log(`\nMUT: ${results.filter(([, ok]) => ok).length}/${results.length} checks reported ok`);
process.exit(0);
