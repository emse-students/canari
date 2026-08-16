#!/usr/bin/env node
/**
 * MENTION-1..6 - the @mention composer, the cleartext `mentionedUserIds` routing hint it produces
 * on channels, and the per-channel notification level it is meant to serve.
 *
 * WHAT THE APP ACTUALLY PROMISES (read off the source, not guessed):
 *
 *   TOKEN FORMAT (`mentions.ts`): a mention is stored as `@[id]`, `id` = 64 lowercase hex chars
 *     (`MENTION_USER_ID_PATTERN`, the OIDC sub, no dashes). `extractMentionUserIds` is a PURE regex
 *     over the text - it does not check the id is a real account or a channel member.
 *   COMPOSER (`useMentionAutocomplete.svelte.ts` + `mentionEditor.ts`): typing `@<partial>` debounces
 *     250ms then hits `/api/users/search?q=`; picking a suggestion (`select()`) replaces the query
 *     with `formatMentionToken(id) + ' '` and the contenteditable re-renders it as a
 *     `<span data-mention-id class="mention-editor-chip">` (`createMentionChip`,
 *     `MENTION_CHIP_SELECTOR = '[data-mention-id].mention-editor-chip'`). Suggestions are scoped by
 *     `allowedUserIds` (`MainChatPage.svelte` `composerAllowedUserIds`): channel members only for a
 *     channel, `undefined` (unrestricted) for a DM unless it is also a group. The scoping is
 *     CLIENT-SIDE ONLY - `extractMentionUserIds` runs on whatever text is in the box regardless, so
 *     a raw `@[id] ` token for a non-member still parses and sends (MENTION-5).
 *   CLEARTEXT LEAK, CHANNELS ONLY (`messaging.ts:101`, inside `isChannelConversationId(...)`):
 *     `extractMentionUserIds(text)` is computed and attached as `mentionedUserIds` on
 *     `SendChannelMessageDto` (`ChannelService.ts`) - "so the server can route the `mentions`
 *     notification level without decrypting. Exposes WHO is mentioned (never the content)." This is
 *     the ONE documented gap; MENTION-6 exists to confirm it is EXACTLY that gap and nothing wider.
 *     The DM/group send path (`messaging.ts`, the branch above line 101) never calls
 *     `extractMentionUserIds` at all - MENTION-4 is the negative space of MENTION-6.
 *   NOTIFICATION LEVEL (`ChannelSettingsModal.svelte`, `ChannelService.ts`
 *     `ChannelNotificationLevel = 'all' | 'mentions' | 'none'`): a PER-USER, PER-CHANNEL setting
 *     persisted server-side (`GET/PATCH .../notification-level`). It gates what the SERVER pushes,
 *     never what the CLIENT sends - `mentionedUserIds` is attached unconditionally by the sender's
 *     own client, independent of the RECEIVER's chosen level. MENTION-2/3 read the DTO the sender
 *     issues, which is the only half of this a browser tab can see; the routing decision itself
 *     happens server-side and lands on the receiver's device, which is why the push itself is owed
 *     to the mobile verification phase for both.
 *
 * MISSING HOOKS FOUND WHILE WRITING THIS (see the final report - each is a candidate fix):
 *   - `MentionDropdown.svelte`'s suggestions (`<li><button>@{name}</button></li>`) carry no
 *     `role="listbox"/"option"` and no `data-user-id` - contrast `UserAutocomplete.svelte`, a
 *     DIFFERENT picker used elsewhere in the app, which has the full ARIA 1.2 combobox pattern. The
 *     mention dropdown has none of it: no announcement when it opens, no relation between the input
 *     and the list, and this harness can only ever click "the top suggestion" (`.mention-composer ul
 *     button`, first match by DOM order) rather than a specific person by id.
 *   - The RENDERED chip after send (`MessageMentionChip.svelte`) is a bare
 *     `<button onclick>@{name}</button>` with no `data-mention-id` of its own - unlike the COMPOSER's
 *     chip, which does carry one. The composer chip is therefore used as ground truth throughout;
 *     the rendered one can only be located by scoping to the message bubble that carries a marker
 *     (the same convention `clickBubbleAction` in chat.mjs already uses for hover-toolbar actions).
 *   - `ChannelSettingsModal.svelte`'s three notification-level buttons (Tous/Mentions/Aucune) have no
 *     `aria-pressed` and no `data-*` marking which one is active - only a Tailwind class
 *     (`border-amber-500`) distinguishes the selected one, found here by reading the component, not
 *     by a hook meant for this. A screen reader gets no "selected" announcement either.
 *
 *   node mention.mjs                 # all six
 *   node mention.mjs --only 6        # one
 */
import { randomBytes } from 'node:crypto';
import {
  client,
  evaluate,
  openDM,
  openChannel,
  realClick,
  until,
  awaitMessage,
  fireComposer,
  goto,
  COMPOSER,
  SEND_ENABLED,
} from './chat.mjs';
import { record, recordObserved, mark } from './results.mjs';
import { watch } from './watch.mjs';
import { PEER_NAME, PORTS, VENUE } from './names.mjs';

/**
 * A CLIENT AND THE OBSERVER THAT WATCHES IT - see the twin in `search.mjs` for why they are one call.
 *
 * MENTION recorded six verdicts having attached no observer at all. It is the phase least able to
 * afford that: a mention is a chip whose whole content is a UUID, and every failure mode here -
 * an unresolved user, a chip that renders as raw `@[...]`, a navigation to a profile that 404s -
 * announces itself in the console long before it changes anything this check can see on screen.
 */
async function observed(port, label) {
  const cx = await client(port);
  return [cx, await watch(cx, label)];
}

const { W1 } = PORTS;

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

// --- selectors, all taken from the source read above, not guessed --------------------------------
// Composer-side chip - the ONE mention surface with a real hook (mentionEditor.ts MENTION_CHIP_SELECTOR).
const MENTION_CHIP_SELECTOR = '[data-mention-id].mention-editor-chip';
// No role/data hook exists on the dropdown (finding above) - first match IS the top suggestion,
// because MentionDropdown renders suggestions in server response order with no re-sort.
const MENTION_SUGGESTION = '.mention-composer ul button';
const SETTINGS_TOGGLE = 'text=Paramètres du canal'; // ChatHeader.svelte aria-label, channel case
// Modal.svelte: role="dialog", aria-label = its title prop - which is the SAME string as the
// toggle's aria-label (chat_channel_settings_label and chat_channel_settings_title are both
// "Paramètres du canal" in fr.json), so this selector only ever matches the open modal, never the
// header button that opened it (RESOLVE's "clickable at its own centre" rule already excludes an
// element sitting under the modal's overlay).
const SETTINGS_MODAL = '[role="dialog"][aria-label="Paramètres du canal"]';
const MODAL_CLOSE = 'text=Fermer'; // Modal.svelte's close button, hardcoded aria-label, icon-only
const NOTIF_ALL = 'Tous'; // m.chat_channel_notif_all_label()
const NOTIF_MENTIONS = 'Mentions'; // m.chat_channel_notif_mentions_label()
const NOTIF_NONE = 'Aucune'; // m.chat_channel_notif_none_label()

/** Whether the notif-level button labelled `label` currently carries the "selected" utility class -
 * the only observable signal, see the file header finding. */
const notifButtonSelected = (label) => `(function () {
  var b = [].filter.call(document.querySelectorAll('button'), function (e) {
    return (e.innerText || '').trim() === ${JSON.stringify(label)};
  })[0];
  return !!b && b.className.indexOf('border-amber-500') !== -1;
})()`;

/**
 * Opens the channel settings modal (assumed already on the channel), picks a notification level,
 * confirms the UI reflects it, and closes the modal again. Returns whether the confirmation was
 * observed - a check that could not even prove the level took must not treat what follows as valid.
 */
async function setChannelNotifLevel(cx, label) {
  await realClick(cx, SETTINGS_TOGGLE);
  await until(cx, `!!document.querySelector('${SETTINGS_MODAL}')`, 6000);
  await realClick(cx, `text=${label}`);
  const confirmed = await until(cx, notifButtonSelected(label), 4000, 100)
    .then(() => true)
    .catch(() => false);
  await realClick(cx, MODAL_CLOSE);
  await until(cx, `!document.querySelector('${SETTINGS_MODAL}')`, 4000).catch(() => {});
  return confirmed;
}

/**
 * Clears the composer, types `@<query>`, waits for the suggestion dropdown, clicks the TOP
 * suggestion, and waits for the resulting chip - returning its `data-mention-id` (ground truth for
 * every assertion below). `query` must be specific enough that the intended person is the first
 * (ideally only) hit; every check here uses the peer's first name against a two-account test
 * environment, which is the harness's own guarantee, not the app's.
 */
async function mentionViaAutocomplete(cx, query) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text: '' }); // clear any leftover draft before arming
  await cx.send('Input.insertText', { text: `@${query}` });
  await until(cx, `!!document.querySelector('${MENTION_SUGGESTION}')`, 6000);
  await realClick(cx, MENTION_SUGGESTION);
  await until(cx, `!!document.querySelector('${MENTION_CHIP_SELECTOR}')`, 4000);
  return evaluate(
    cx,
    `(function () {
      var chip = document.querySelector('${MENTION_CHIP_SELECTOR}');
      return chip ? chip.dataset.mentionId : null;
    })()`
  );
}

/** The rendered chip's viewport point, found within the message bubble carrying `marker` - the
 * rendered chip has no hook of its own (finding above), so it is scoped like `clickBubbleAction`
 * scopes a hover-toolbar action: to the paragraph that actually holds the marker text. */
async function chipButtonIn(cx, marker) {
  const raw = await evaluate(
    cx,
    `JSON.stringify((function () {
      var pane = document.querySelector('${COMPOSER}').closest('section');
      var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
        return (e.textContent || '').indexOf(${JSON.stringify(marker)}) !== -1;
      });
      if (!hits.length) return null;
      var p = hits[hits.length - 1];
      var btn = p.querySelector('button');
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      var r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: btn.textContent.trim() };
    })())`
  );
  return raw && raw !== 'null' ? JSON.parse(raw) : null;
}

/** Clicks at a page point directly - the same raw dispatch `clickBubbleAction` uses once the target
 * is already known, for exactly the same reason: no selector distinguishes this button from others. */
async function clickPoint(cx, { x, y }) {
  await cx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cx.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}

// --- network capture: cx.events is a Node-side array (cdp.mjs `connect`), so it is read from Node,
// never through evaluate()/until() which run IN THE PAGE and cannot see it. -----------------------

const CHANNEL_MESSAGES_POST = /\/api\/channels\/[^/]+\/messages(\?|$)/;

/** `Network.requestWillBeSent` events queued since `sinceIdx`. */
const networkRequestsSince = (cx, sinceIdx) =>
  cx.events.slice(sinceIdx).filter((e) => e.method === 'Network.requestWillBeSent');

/** A request's body, fetching it explicitly when Chrome did not inline it on the event. */
async function requestBody(cx, evt) {
  const { request, requestId } = evt.params;
  if (typeof request.postData === 'string') return request.postData;
  if (!request.hasPostData) return null;
  const r = await cx.send('Network.getRequestPostData', { requestId }).catch(() => null);
  return r ? r.postData : null;
}

/** Host-side poll (NOT `until()` - that evaluates page-side, and this is watching Node state). */
async function pollHost(predicate, timeoutMs = 8000, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

/** Waits for and parses the body of the channel-send POST issued since `sinceIdx`. */
async function awaitChannelSendBody(cx, sinceIdx) {
  const evt = await pollHost(() => {
    const hit = networkRequestsSince(cx, sinceIdx).find(
      (e) => e.params.request.method === 'POST' && CHANNEL_MESSAGES_POST.test(e.params.request.url)
    );
    return hit || null;
  });
  if (!evt) return null;
  const raw = await requestBody(cx, evt);
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------------------------------------
// MENTION-1 - autocomplete inserts a `@[uuid]` chip; the chip renders after send and clicking it
// navigates to the mentioned user's profile.
// ---------------------------------------------------------------------------------------------
async function mention1() {
  const [cx, obs] = await observed(W1, 'MENTION-1');
  await openDM(cx, PEER_NAME);

  const term = mark('MENTION1');
  const query = PEER_NAME.split(' ')[0];
  const mentionId = await mentionViaAutocomplete(cx, query);
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const bubbleChip = await chipButtonIn(cx, term);
  let navigatedPath = null;
  if (bubbleChip) {
    await clickPoint(cx, bubbleChip);
    navigatedPath = await until(cx, `location.pathname.indexOf('/profile/') === 0`, 5000)
      .then(() => evaluate(cx, 'location.pathname'))
      .catch(() => null);
  }
  const navigatedId = navigatedPath ? navigatedPath.replace('/profile/', '') : null;

  const ok = !!mentionId && !!bubbleChip && navigatedId === mentionId;
  await recordObserved('MENTION-1', ok ? 'PASS' : 'FAIL', {
    query,
    composerChipMentionId: mentionId, // the one hooked surface - ground truth for the rest
    bubbleChipFound: !!bubbleChip,
    bubbleChipText: bubbleChip?.text ?? null,
    navigatedPath,
    idsMatch: navigatedId === mentionId,
  }, { W1: obs });
  if (navigatedPath) await goto(cx, '/chat'); // leave W1 on the conversation list, not a profile page
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-2 - channel, notif level "Mentions": the sender's client attaches mentionedUserIds. The
// PUSH ITSELF cannot be observed from a browser tab - see the file header - so this can only ever
// be PARTIAL, never PASS.
// ---------------------------------------------------------------------------------------------
async function mention2() {
  const [cx, obs] = await observed(W1, 'MENTION-2');
  await openChannel(cx, VENUE.community, VENUE.channel);

  const levelSet = await setChannelNotifLevel(cx, NOTIF_MENTIONS);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION2');
  const query = PEER_NAME.split(' ')[0];
  const mentionId = await mentionViaAutocomplete(cx, query);
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const containsPeer = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(mentionId);

  await setChannelNotifLevel(cx, NOTIF_ALL); // restore the default - do not leave the account on "mentions"

  const clientPreconditionOk = levelSet && !!mentionId && containsPeer;
  await recordObserved('MENTION-2', clientPreconditionOk ? 'PARTIAL' : 'FAIL', {
    notifLevelSet: 'mentions',
    notifLevelUiConfirmed: levelSet,
    mentionId,
    mentionedUserIdsSent: mentionedUserIds,
    containsMentionedPeer: containsPeer,
    pushObserved: null,
    note:
      'PARTIAL, never PASS: confirms only the client-side precondition (level persisted + ' +
      'mentionedUserIds attached for a mentions-level channel). Whether the peer actually received a ' +
      'push is not observable from a browser tab - owed to the mobile verification phase ' +
      '(docs/wiki/device-verification.md).',
  }, { W1: obs });
  cx.close();
  return clientPreconditionOk;
}

// ---------------------------------------------------------------------------------------------
// MENTION-3 - channel, notif level "Aucune". The deterministic claim available from here: the
// CLIENT still attaches mentionedUserIds regardless of the receiver's level, because the level is a
// server-side routing decision (ChannelNotificationLevel doc comment), never a client-side filter.
// "The mention triggers nothing" for the receiver is a push claim this harness cannot make.
// ---------------------------------------------------------------------------------------------
async function mention3() {
  const [cx, obs] = await observed(W1, 'MENTION-3');
  await openChannel(cx, VENUE.community, VENUE.channel);

  const levelSet = await setChannelNotifLevel(cx, NOTIF_NONE);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION3');
  const query = PEER_NAME.split(' ')[0];
  const mentionId = await mentionViaAutocomplete(cx, query);
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const stillSentClientSide = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(mentionId);

  await setChannelNotifLevel(cx, NOTIF_ALL); // restore the default

  const ok = levelSet && stillSentClientSide;
  await recordObserved('MENTION-3', ok ? 'PASS' : 'FAIL', {
    notifLevelSet: 'none',
    notifLevelUiConfirmed: levelSet,
    mentionId,
    mentionedUserIdsSent: mentionedUserIds,
    verdictMeaning:
      'PASS confirms the client attaches mentionedUserIds regardless of the level - suppression, if ' +
      'any, is a server routing decision this harness cannot observe. NOT a claim that no push arrived ' +
      'at the peer; that half is owed to the mobile phase, same as MENTION-2.',
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-4 - DM/group: a mention triggers NOTHING extra. messaging.ts:101 calls
// extractMentionUserIds ONLY inside the channel branch, so the DM/group send path never computes
// it - this check watches every request the send fires, not just the channel endpoint, because the
// claim is "nothing extra rides along" and a narrower filter would beg the question.
// ---------------------------------------------------------------------------------------------
async function mention4() {
  const [cx, obs] = await observed(W1, 'MENTION-4');
  await openDM(cx, PEER_NAME);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION4');
  const query = PEER_NAME.split(' ')[0];
  const mentionId = await mentionViaAutocomplete(cx, query);
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  // DMs go over the gateway WebSocket, not HTTP, so no request is expected at all - this settle is
  // what gives any stray HTTP the send path might fire time to actually land before it is inspected.
  await new Promise((r) => setTimeout(r, 1500));
  const since = networkRequestsSince(cx, sinceIdx);
  const bodies = await Promise.all(
    since.map((e) =>
      requestBody(cx, e).then((b) => ({ url: e.params.request.url, method: e.params.request.method, body: b }))
    )
  );
  const channelEndpointHit = since.some((e) => CHANNEL_MESSAGES_POST.test(e.params.request.url));
  const leaked = bodies.filter((b) => typeof b.body === 'string' && b.body.includes('mentionedUserIds'));

  const ok = !channelEndpointHit && leaked.length === 0;
  await recordObserved('MENTION-4', ok ? 'PASS' : 'FAIL', {
    mentionId,
    channelEndpointHit,
    requestsObserved: since.length,
    leakedMentionedUserIds: leaked.map((b) => ({ url: b.url, method: b.method })),
    source:
      'messaging.ts:101 - extractMentionUserIds runs ONLY inside the isChannelConversationId branch; ' +
      'the DM/group path above it never calls it.',
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-5 - mentioning a user who is NOT a channel member. The autocomplete only ever OFFERS
// members (composerAllowedUserIds), so this bypasses it entirely: a fabricated, well-formed
// `@[64-hex]` token typed straight into the composer, which extractMentionUserIds accepts with no
// membership check. Recorded as a finding of what happens, not graded against an expected outcome.
// ---------------------------------------------------------------------------------------------
async function mention5() {
  const [cx, obs] = await observed(W1, 'MENTION-5');
  await openChannel(cx, VENUE.community, VENUE.channel);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const fakeId = randomBytes(32).toString('hex'); // matches MENTION_USER_ID_PATTERN, no real account
  const term = mark('MENTION5');

  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text: `@[${fakeId}] ${term}` });
  await until(cx, `!!document.querySelector('[data-mention-id="${fakeId}"]')`, 5000);
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const sentDespiteNonMembership = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(fakeId);
  const bubbleChip = await chipButtonIn(cx, term);

  await recordObserved('MENTION-5', sentDespiteNonMembership ? 'PASS' : 'FAIL', {
    fakeUserId: fakeId,
    mentionedUserIdsSent: mentionedUserIds,
    sentDespiteNonMembership,
    renderedFallbackLabel: bubbleChip?.text ?? null, // expect the raw id (mentions.parse.ts fallback)
    note:
      'PASS here means the client neither blocks the send nor validates membership, matching the ' +
      'source read above - it is a finding about the CLIENT, not a verdict on the server: whether the ' +
      'server routes a push for a mention outside the channel is unobserved by this check.',
  }, { W1: obs });
  cx.close();
  return sentDespiteNonMembership;
}

// ---------------------------------------------------------------------------------------------
// MENTION-6 - SECURITY: mentionedUserIds rides in cleartext on the channel send (documented,
// known), and this confirms it is EXACTLY that leak - the key-set matches SendChannelMessageDto and
// nothing wider. ciphertext/nonce values and all request HEADERS are deliberately excluded from the
// record: logging them would put a second secret into the file this check exists to keep clean of one.
// ---------------------------------------------------------------------------------------------
async function mention6() {
  const [cx, obs] = await observed(W1, 'MENTION-6');
  await openChannel(cx, VENUE.community, VENUE.channel);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION6');
  const query = PEER_NAME.split(' ')[0];
  const mentionId = await mentionViaAutocomplete(cx, query);
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);

  const KNOWN_KEYS = new Set(['ciphertext', 'nonce', 'keyVersion', 'messageId', 'poll', 'mentionedUserIds']);
  const bodyKeys = body ? Object.keys(body) : [];
  const unexpectedKeys = bodyKeys.filter((k) => !KNOWN_KEYS.has(k));
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const carriesPeerId = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(mentionId);
  const onlyPeerId = Array.isArray(mentionedUserIds) && mentionedUserIds.length === 1;

  // REDACTED ON PURPOSE - lengths only, never the values, never a header.
  const ciphertextPresent = typeof body?.ciphertext === 'string' && body.ciphertext.length > 0;
  const noncePresent = typeof body?.nonce === 'string' && body.nonce.length > 0;

  const ok = bodyKeys.length > 0 && unexpectedKeys.length === 0 && carriesPeerId && onlyPeerId;
  await recordObserved('MENTION-6', ok ? 'PASS' : 'FAIL', {
    bodyKeysObserved: bodyKeys,
    unexpectedKeys, // must be empty - anything here is a wider leak than the documented one
    mentionedUserIdsCount: mentionedUserIds?.length ?? null,
    carriesMentionedPeerId: carriesPeerId,
    ciphertextPresent,
    ciphertextLength: body?.ciphertext?.length ?? null, // length only, never the value
    noncePresent,
    nonceLength: body?.nonce?.length ?? null, // length only, never the value
    redactionNote: 'ciphertext/nonce values and all request headers are excluded from this record on purpose.',
  }, { W1: obs });
  cx.close();
  return ok;
}

const CHECKS = { 1: mention1, 2: mention2, 3: mention3, 4: mention4, 5: mention5, 6: mention6 };

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`MENTION-${n}`, 'ERROR', { error: e.message });
    results.push([n, false]);
  }
}
console.log(`\nMENTION: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE HERE - see the twin note at the foot of `search.mjs`. These booleans are the assertion
// half only; `results.mjs` derives the code from the recorded verdicts, which are the gated ones.
// MENTION-2 makes the point sharply: it returns `clientPreconditionOk` and records PARTIAL, so this
// loop called a run that is explicitly NOT a pass a pass, and exited 0 on it.
//
// CONSEQUENCE, STATED RATHER THAN WORKED AROUND: MENTION-2 is PARTIAL by construction - whether the
// peer's phone actually rang is not observable from a browser tab - so this phase exits non-zero
// until the mobile half is taken. That is a standing debt reported accurately, not a false alarm,
// and it clears the day `device-verification` covers it. Making PARTIAL exit 0 would buy silence by
// declaring the unverified half verified, which is the trade this whole audit exists to refuse.
