#!/usr/bin/env node
/**
 * SEARCH-1..6 - the two searches this app has (in-conversation full-history, and the sidebar
 * conversation filter), plus the channel decrypt-and-search path.
 *
 * WHAT THE APP ACTUALLY PROMISES (read off the source, not guessed):
 *
 *   IN-CONVERSATION (ChatArea.svelte `refreshSearchMatches`): calls `onSearchAll(convId, query)`.
 *     - DMs/groups (`MainChatPage.searchConversation`): reads the FULL local IndexedDB history
 *       (`session.storage.getMessages`), filters `!isDeleted`, matches
 *       `getPreviewText(parseEnvelope(content)).toLowerCase().includes(q)`. This is NOT windowed by
 *       what is currently rendered - the render window (`INITIAL_RENDER_GROUPS`, ChatArea.svelte:226)
 *       is a DOM-node budget, unrelated to what storage holds.
 *     - Channels (`useConversations.svelte.ts searchChannelHistory`): fetch up to 2000 rows from the
 *       server (`channelService.fetchAllChannelMessages`), decrypt each, match the same way. Also
 *       NOT windowed by the in-memory page loaded on open (`loadChannelHistory` only fetches the
 *       most recent 200 for the initial render - search re-fetches independently).
 *     - `searchLimitedToLoaded` (ChatArea.svelte:248/566/586/789) is set true ONLY on the branch
 *       where `onSearchAll` returns `null` - which for DMs/groups means `session.storage` is falsy,
 *       and for channels means `searchChannelHistory` THREW (caught in ChatArea's try/catch). A
 *       channel search that merely got CAPPED at 2000 rows (`capped: true`, only ever logged via
 *       `ctx.log`, never surfaced to `searchLimitedToLoaded`) is NOT that branch - the flag would
 *       stay false and the UI would give no visible sign the search missed anything past row 2000.
 *       SEARCH-2 tests the one branch that DOES fire (a forced fetch failure), because manufacturing
 *       a >2000-message channel inside a check is not practical; the cap gap is recorded from the
 *       source read, not exercised, and is called out explicitly below.
 *   CASE/ACCENT FOLDING (`splitWithHighlight`, chat/messageDisplay.ts:218 - same function backs both
 *     the search filter and the `<mark>` highlighter): `text.toLowerCase().indexOf(needle.toLowerCase())`.
 *     Plain `String.toLowerCase()` folds CASE, not DIACRITICS - 'É'.toLowerCase() === 'é', but
 *     'e' !== 'é'. SEARCH-5 measures exactly that seam.
 *   SIDEBAR FILTER (Sidebar.svelte:235 `filteredConversationEntries`): `convo.name` OR the RAW last
 *     message envelope string, both `.toLowerCase().includes(query)`. No `getPreviewText`, no
 *     `parseEnvelope` on the match side, and no history beyond the single last message.
 *
 * MISSING HOOKS FOUND WHILE WRITING THIS (see the final report - each is a candidate fix):
 *   - The sidebar's own search `<input>` (SidebarHeaderControls.svelte) carries no class/id/role at
 *     all, unlike `.chat-search-input` for the in-conversation one. Located here by exclusion.
 *   - Conversation tiles (ConversationTile.svelte) are a bare `<button>` with only Tailwind utility
 *     classes - no `data-conversation-id`, no `role="listitem"`. SEARCH-6 has to scope by the
 *     PARENT list container's utility-class combination instead, which is exactly the kind of
 *     selector this campaign avoids everywhere else.
 *   - `MessageBubble`'s `isHighlighted` prop ("pulses a ring ... as the search result",
 *     MessageBubble.svelte:121) is declared and READ (line 652) but never PASSED from anywhere in
 *     the tree (`grep isHighlighted=` across src is empty). The only visible "you are here" signal
 *     for the active hit is the transient `.chat-message-jump-highlight` class (1.8s pulse) added by
 *     `navigateToMessage`, plus the `N/M` counter text - every match gets the same `<mark>`, not just
 *     the active one. Recorded, not treated as a fail (SEARCH-1 does not depend on the ring).
 *   - The channel search's 2000-row cap (`capped: true`) never reaches the UI - see above.
 *
 *   node search.mjs                 # all six
 *   node search.mjs --only 5        # one
 */
import {
  client,
  evaluate,
  openDM,
  openChannel,
  realClick,
  until,
  send,
  awaitMessage,
  clickBubbleAction,
  activate,
  goto,
} from './chat.mjs';
import { record, recordObserved, mark } from './results.mjs';
import { ignoringOfflineCut, report, watch } from './watch.mjs';
import { PEER_NAME, PORTS, VENUE } from './names.mjs';

const { W1 } = PORTS;

/**
 * A CLIENT AND THE OBSERVER THAT WATCHES IT, together - because separately, six checks took the
 * first and none took the second.
 *
 * SEARCH shipped six verdicts with `watch = 0` and `report = 0`: not one of them looked at a console
 * line, and all six read as passes. Search is the phase where that omission bites hardest - every
 * check here DECRYPTS (`searchChannelHistory` walks up to 2000 rows through MLS), so a failing
 * decrypt shows up as a missing hit and nothing else. `0/0` is what a search with no matches looks
 * like AND what a search whose messages would not open looks like; only the console separates them.
 */
async function observed(port, label) {
  const cx = await client(port);
  return [cx, await watch(cx, label)];
}

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

// --- selectors, all taken from the source read above, not guessed --------------------------------
const SEARCH_TOGGLE = 'text=Rechercher dans la conversation'; // ChatHeader.svelte:257 aria-label
const SEARCH_INPUT = '.chat-search-input'; // ChatArea.svelte:780
const SEARCH_COUNT = '.chat-search-count'; // ChatArea.svelte:799
const SEARCH_NEXT = 'text=Occurrence suivante'; // ChatArea.svelte:817 aria-label
const SEARCH_PREV = 'text=Occurrence précédente'; // ChatArea.svelte:808 aria-label
// The exact French string ChatArea.svelte:826 renders - THIS STRING IS THE SUBJECT of SEARCH-2, not
// an assertion-on-prose shortcut: there is no `data-search-limited` hook (see the finding above), so
// the only way to observe the UI's own admission is to look for the sentence it prints.
const LIMITED_WARNING = "Recherche limitée aux messages chargés. Faites défiler vers le haut pour en charger davantage.";
const EDIT_ACTION = 'Modifier'; // common_edit_label
const DELETE_ACTION = 'Supprimer'; // common_delete_button (also the delete-toolbar aria-label)
const SAVE_BUTTON = 'text=Enregistrer'; // common_save_button, inside MessageEditForm
// The sidebar list container has no stable hook of its own (finding above) - this is the exact
// Tailwind class triple Sidebar.svelte:474-477 puts on it, which is the closest thing to a
// selector that exists today.
const SIDEBAR_LIST = '.flex-1.overflow-y-auto.p-2\\.5';

/** Opens the in-conversation search panel (idempotent: no-ops if already open). */
async function openSearchPanel(cx) {
  if (await evaluate(cx, `!!document.querySelector('${SEARCH_INPUT}')`)) return;
  await realClick(cx, SEARCH_TOGGLE);
  await until(cx, `!!document.querySelector('${SEARCH_INPUT}')`, 8000);
}

/** Replaces the search box's content - a plain `<input>`, so `.select()` + insertText, not the
 * contenteditable selectAll dance `armComposer` needs for the composer. */
async function typeInSearch(cx, text) {
  await realClick(cx, SEARCH_INPUT);
  await evaluate(
    cx,
    `(function () { var i = document.querySelector('${SEARCH_INPUT}'); i.focus(); i.select(); })()`
  );
  await cx.send('Input.insertText', { text });
}

const searchCountText = (cx) =>
  evaluate(cx, `((document.querySelector('${SEARCH_COUNT}') || {}).innerText || '').trim()`);

/** How many `<mark>` hit-spans are currently rendered anywhere in the pane, and their joined text. */
const markHits = (cx) =>
  evaluate(
    cx,
    `JSON.stringify([].map.call(document.querySelectorAll('mark'), function (e) { return e.textContent; }))`
  ).then((s) => JSON.parse(s));

const bodyHasWarning = (cx) =>
  evaluate(cx, `document.body.innerText.indexOf(${JSON.stringify(LIMITED_WARNING)}) !== -1`);

// ---------------------------------------------------------------------------------------------
// SEARCH-1 - a recent term is found and highlighted; prev/next walk the hits.
// ---------------------------------------------------------------------------------------------
async function search1() {
  const [cx, obs] = await observed(W1, 'SEARCH-1');
  await openDM(cx, PEER_NAME);

  const term = mark('SEARCH1');
  await send(cx, `${term} first hit`);
  await awaitMessage(cx, term);
  await send(cx, `${term} second hit`);
  await awaitMessage(cx, `${term} second`);

  await openSearchPanel(cx);
  await typeInSearch(cx, term);
  // Oldest-first (the documented contract of onSearchAll), so index 0 is "first hit" -> "1/2".
  const settled = await until(
    cx,
    `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '1/2'`,
    8000,
    100
  ).catch(() => null);
  const countAfterOpen = await searchCountText(cx);
  const hits = await markHits(cx);
  const hitsMatchTerm = hits.length >= 2 && hits.every((h) => h.toLowerCase() === term.toLowerCase());

  await realClick(cx, SEARCH_NEXT);
  const afterNext = await until(
    cx,
    `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '2/2'`,
    5000,
    100
  )
    .then(() => '2/2')
    .catch(() => searchCountText(cx));

  await realClick(cx, SEARCH_PREV);
  const afterPrev = await until(
    cx,
    `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '1/2'`,
    5000,
    100
  )
    .then(() => '1/2')
    .catch(() => searchCountText(cx));

  // Wrap-around: PREV from index 0 must go to the LAST hit, not clamp or throw.
  await realClick(cx, SEARCH_PREV);
  const wrapped = await until(
    cx,
    `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '2/2'`,
    5000,
    100
  )
    .then(() => '2/2')
    .catch(() => searchCountText(cx));

  // The jump highlight class - the ONLY per-hit visual marker that actually exists (see the header
  // note on `isHighlighted` being unwired). Just check it was applied by the last navigation.
  const jumpHighlighted = await evaluate(
    cx,
    `document.querySelectorAll('.chat-message-jump-highlight').length`
  );

  const ok =
    settled !== null && hitsMatchTerm && afterNext === '2/2' && afterPrev === '1/2' && wrapped === '2/2';
  await recordObserved('SEARCH-1', ok ? 'PASS' : 'FAIL', {
    initialCount: countAfterOpen,
    hits,
    afterNext,
    afterPrev,
    wrappedAfterPrev: wrapped,
    jumpHighlightApplied: jumpHighlighted > 0,
    note: 'isHighlighted (per-hit ring) is declared on MessageBubble but never passed anywhere in the tree - not asserted on, see file header',
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-2 - does searchLimitedToLoaded tell the truth?
//
// The only branch that sets it true is `onSearchAll` returning `null` (ChatArea.svelte:566/584-586),
// which for a channel means `searchChannelHistory` THREW. That is reproduced deterministically (no
// clock, no guessing) by taking the client offline right before the search fires, forcing the
// server fetch to reject. The check then asks two honest questions: does the UI still SHOW something
// (the degraded in-memory fallback), and does it ADMIT the degradation (the warning banner) - a
// silent empty result would be worse than either.
// ---------------------------------------------------------------------------------------------
async function search2() {
  const [cx, obs] = await observed(W1, 'SEARCH-2');
  await openChannel(cx, VENUE.community, VENUE.channel);

  const term = mark('SEARCH2');
  await send(cx, `${term} still findable offline`);
  await awaitMessage(cx, term);

  await cx.send('Network.enable');
  await cx.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });

  await openSearchPanel(cx);
  await typeInSearch(cx, term);
  // Give the failed fetch time to reject and the catch branch time to fall back.
  await new Promise((r) => setTimeout(r, 2500));

  const count = await searchCountText(cx);
  const warningShown = await bodyHasWarning(cx);
  const hits = await markHits(cx);
  const foundViaFallback = hits.some((h) => h.toLowerCase() === term.toLowerCase());

  await cx.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // The truth-telling contract: found via the degraded in-memory fallback (the message we just sent
  // is already in `conversation.messages`, live) AND the UI admits it was limited. Either half
  // failing is the interesting result, so both are recorded regardless of the verdict.
  const ok = foundViaFallback && warningShown;
  // THE CUT IS THIS CHECK'S OWN, so its consequences are forgiven and counted - and only those. The
  // whole method here is to make a server fetch reject, which produces exactly the disconnected
  // fetches `ignoringOfflineCut` names; left in, SEARCH-2 could never be clean and its observation
  // would discriminate nothing. What it does NOT forgive is the interesting half: an unhandled
  // rejection while offline is a defect, and a decrypt that failed is not a network error.
  await recordObserved('SEARCH-2', ok ? 'PASS' : 'FAIL', {
    scenario: 'server fetch forced offline mid-search (channel path)',
    count,
    foundViaFallback,
    warningShown,
    hits,
    knownGapNotExercised:
      'searchChannelHistory caps at 2000 rows (useConversations.svelte.ts ~440) and never sets ' +
      'searchLimitedToLoaded when capped - only the throw path does. Not reproduced here (would need ' +
      '>2000 messages in the channel); flagged from the source read only.',
  }, { W1: ignoringOfflineCut(await report(obs)) });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-3 - deleted messages are excluded; an edited message matches its NEW text, not the old.
// Edit is DM/group only (`onEdit` is `undefined` for channels - MainChatPage.svelte:927-929), so
// this runs in the DM, never the channel.
// ---------------------------------------------------------------------------------------------
async function search3() {
  const [cx, obs] = await observed(W1, 'SEARCH-3');
  await openDM(cx, PEER_NAME);

  const termDeleted = mark('SEARCH3DEL');
  const termOld = mark('SEARCH3OLD');
  const termNew = mark('SEARCH3NEW');

  await send(cx, `${termDeleted} will be deleted`);
  await awaitMessage(cx, termDeleted);
  await send(cx, `${termOld} original text`);
  await awaitMessage(cx, termOld);

  // --- delete the first message ---
  // Confirmation is MessageBubble's OWN modal (not the global showConfirm store), shared `Modal.svelte`
  // (`role="dialog"`, aria-label = its title). Scope the confirm click to that dialog rather than a
  // bare `text=Supprimer`: the hover toolbar's own delete button (icon-only, same aria-label, no
  // visible text) can still be sitting under the pointer at this point, and RESOLVE's "visible text
  // beats a label" rule already prefers the modal's button - but scoping removes the ambiguity
  // instead of relying on that tie-break.
  await clickBubbleAction(cx, termDeleted, DELETE_ACTION);
  const DELETE_DIALOG = `[role="dialog"][aria-label="Supprimer le message"]`;
  await until(cx, `!!document.querySelector('${DELETE_DIALOG}')`, 5000);
  // `activate()`, not `realClick()`: this is plumbing (a confirmation dialog), and the delete-toolbar
  // button behind it shares the same aria-label with no visible text of its own - `activate` resolves
  // by RESOLVE's own text/visibility rules scoped to a plain CSS selector, landing on the dialog's
  // own (last) button, which carries real innerText ("Supprimer").
  await activate(cx, `${DELETE_DIALOG} button:last-of-type`);
  await until(cx, `!document.querySelector('${DELETE_DIALOG}')`, 5000).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  // --- edit the second message ---
  await clickBubbleAction(cx, termOld, EDIT_ACTION);
  await until(cx, `!!document.querySelector('textarea')`, 5000);
  await realClick(cx, 'textarea');
  await evaluate(cx, `document.querySelector('textarea').select()`);
  await cx.send('Input.insertText', { text: `${termNew} edited text` });
  await realClick(cx, SAVE_BUTTON);
  await until(cx, `!document.querySelector('textarea')`, 5000).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  // --- search all three terms ---
  await openSearchPanel(cx);

  await typeInSearch(cx, termDeleted);
  await new Promise((r) => setTimeout(r, 1200));
  const deletedCount = await searchCountText(cx);

  await typeInSearch(cx, termOld);
  await new Promise((r) => setTimeout(r, 1200));
  const oldCount = await searchCountText(cx);

  await typeInSearch(cx, termNew);
  await until(cx, `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '1/1'`, 8000, 100).catch(
    () => {}
  );
  const newCount = await searchCountText(cx);

  const ok = deletedCount === '0/0' && oldCount === '0/0' && newCount === '1/1';
  await recordObserved('SEARCH-3', ok ? 'PASS' : 'FAIL', {
    deletedMessageSearch: deletedCount, // expect 0/0
    editedMessageOldTextSearch: oldCount, // expect 0/0 - the old text no longer exists anywhere
    editedMessageNewTextSearch: newCount, // expect 1/1
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-4 - channel search (the 2000-row decrypt path), timed.
// ---------------------------------------------------------------------------------------------
async function search4() {
  const [cx, obs] = await observed(W1, 'SEARCH-4');
  await openChannel(cx, VENUE.community, VENUE.channel);

  const term = mark('SEARCH4');
  await send(cx, `${term} timing probe`);
  await awaitMessage(cx, term);

  await openSearchPanel(cx);
  const t0 = Date.now();
  await typeInSearch(cx, term);
  const elapsedMs = await until(
    cx,
    `(document.querySelector('${SEARCH_COUNT}') || {}).innerText === '1/1'`,
    45000,
    150
  )
    .then((ms) => ms)
    .catch(() => null);
  const totalMs = Date.now() - t0;
  const warningShown = await bodyHasWarning(cx);

  const STALL_MS = 8000; // generous over the WP-PUSHHERD baseline; flagged, not failed, past this
  const ok = elapsedMs !== null;
  // THE OBSERVATION MATTERS MORE HERE THAN THE TIMING. This path decrypts up to 2000 rows one by
  // one, and every frame that will not open is a console line and a hit that is simply absent - so
  // `1/1` arriving on time says nothing about the 1999 rows walked to find it. The gate is what
  // makes this check able to see a partial decrypt failure at all.
  await recordObserved('SEARCH-4', ok ? 'PASS' : 'FAIL', {
    elapsedMs,
    totalWallClockMs: totalMs,
    stall: elapsedMs !== null && elapsedMs > STALL_MS,
    warningShownDuringSuccessfulSearch: warningShown, // must be false - see SEARCH-2's header note
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-5 - accents and case. splitWithHighlight/toLowerCase() folds CASE, not diacritics.
// ---------------------------------------------------------------------------------------------
async function search5() {
  const [cx, obs] = await observed(W1, 'SEARCH-5');
  await openDM(cx, PEER_NAME);

  // One inseparable token so the ONLY variable between the two queries is the accent/case of a
  // single letter - a marker prefix keeps it unique against any "réunion" already in DM history.
  const stamp = mark('SEARCH5');
  const word = `${stamp}Réunion`; // sent exactly once, contains exactly one accented letter
  await send(cx, `${word} budget`);
  await awaitMessage(cx, stamp);

  await openSearchPanel(cx);

  const queryNoAccent = `${stamp}reunion`; // lowercase, accent stripped
  await typeInSearch(cx, queryNoAccent);
  await new Promise((r) => setTimeout(r, 1200));
  const noAccentCount = await searchCountText(cx);
  const noAccentFound = noAccentCount !== '0/0';

  const queryAccentUpper = `${stamp}RÉUNION`; // accent present, case flipped
  await typeInSearch(cx, queryAccentUpper);
  await new Promise((r) => setTimeout(r, 1200));
  const accentUpperCount = await searchCountText(cx);
  const accentUpperFound = accentUpperCount !== '0/0';

  // PREDICTED from the source (messageDisplay.ts:218 splitWithHighlight, plain toLowerCase): the
  // no-accent query should NOT find it ('é'.toLowerCase() !== 'e'), the accented-uppercase query
  // SHOULD (case folds fine once the accent already matches). A check that only asserted "search
  // works" would miss this; the verdict below is about which DIRECTION holds, not whether either
  // one alone passes or fails.
  const matchesPrediction = !noAccentFound && accentUpperFound;
  await recordObserved('SEARCH-5', matchesPrediction ? 'PASS' : 'FAIL', {
    word,
    noAccentQuery: queryNoAccent,
    noAccentFound,
    noAccentCount,
    accentUpperQuery: queryAccentUpper,
    accentUpperFound,
    accentUpperCount,
    verdictMeaning:
      "PASS here means the app's accent-insensitivity gap is confirmed exactly as predicted from " +
      "the source (case folds, diacritics do not) - it is a FINDING either way, not a pass/fail on " +
      'whether accent-insensitive search "works": it does not, by design of splitWithHighlight.',
  }, { W1: obs });
  cx.close();
  return matchesPrediction;
}

// ---------------------------------------------------------------------------------------------
// SEARCH-6 - the sidebar filter matches conversation name + last-message preview ONLY, and does
// not claim to search full history.
// ---------------------------------------------------------------------------------------------
async function search6() {
  const [cx, obs] = await observed(W1, 'SEARCH-6');
  await openDM(cx, PEER_NAME);

  const termA = mark('SEARCH6A');
  const termB = mark('SEARCH6B');
  await send(cx, `${termA} first last-message`);
  await awaitMessage(cx, termA);
  // Superseding it makes termA true FULL-HISTORY content that is no longer the LAST message - the
  // one condition the sidebar filter (Sidebar.svelte:235, matches convo.name OR the last message
  // only) is claimed NOT to look past.
  await send(cx, `${termB} second last-message`);
  await awaitMessage(cx, termB);

  await goto(cx, '/chat');
  await until(cx, `location.pathname === '/chat'`, 10000);

  /** Rows currently rendered in the conversation list whose text includes `needle` (case-fold). */
  const rowsMatching = (needle) =>
    evaluate(
      cx,
      `(function () {
        var list = document.querySelector(${JSON.stringify(SIDEBAR_LIST)});
        if (!list) return null;
        var n = ${JSON.stringify(needle)}.toLowerCase();
        return [].filter.call(list.querySelectorAll('button'), function (b) {
          return (b.innerText || '').toLowerCase().indexOf(n) !== -1;
        }).length;
      })()`
    );

  /** Every row currently rendered, regardless of content - the direct "matches nothing" probe. */
  const totalRows = () =>
    evaluate(
      cx,
      `(function () {
        var list = document.querySelector(${JSON.stringify(SIDEBAR_LIST)});
        return list ? list.querySelectorAll('button').length : null;
      })()`
    );

  /** Sidebar's own search input - no stable hook of its own, see the file header finding. Located
   * by exclusion: a text input that is not the in-conversation search box. */
  const SIDEBAR_INPUT = `[].slice.call(document.querySelectorAll('input[type="text"]')).filter(function (i) { return !i.classList.contains('chat-search-input'); })[0]`;
  async function typeSidebarSearch(text) {
    await evaluate(cx, `(function () { var i = ${SIDEBAR_INPUT}; if (i) { i.focus(); i.select(); } })()`);
    if ((await evaluate(cx, `!!(${SIDEBAR_INPUT})`)) === false) throw new Error('no sidebar search input found');
    await cx.send('Input.insertText', { text });
    await new Promise((r) => setTimeout(r, 250)); // filteredConversationEntries is a plain $derived, no debounce - small settle only
  }

  const beforeRows = await rowsMatching(PEER_NAME);

  await typeSidebarSearch(termB); // current last message - MUST match
  const matchesCurrentLastMessage = (await rowsMatching(termB)) > 0;

  await typeSidebarSearch(termA); // superseded last message, still in full history - MUST NOT match
  const matchesSupersededMessage = (await rowsMatching(termA)) > 0;

  await typeSidebarSearch(PEER_NAME.split(' ')[0]); // conversation name - MUST match
  const matchesName = (await rowsMatching(PEER_NAME)) > 0;

  const junk = `zz-nonexistent-${Date.now().toString(36)}`;
  await typeSidebarSearch(junk); // never sent anywhere - MUST match nothing (proves it isn't a no-op filter)
  const rowsUnderJunkQuery = await totalRows();

  const ok =
    matchesCurrentLastMessage &&
    !matchesSupersededMessage &&
    matchesName &&
    rowsUnderJunkQuery === 0;
  await recordObserved('SEARCH-6', ok ? 'PASS' : 'FAIL', {
    beforeRowsForPeerName: beforeRows,
    matchesCurrentLastMessage,
    matchesSupersededMessage, // expect false - this is the "does NOT search full history" assertion
    matchesName,
    rowsUnderJunkQuery, // expect 0 - proves the filter isn't a silent no-op
    note: "sidebar list has no data-conversation-id/role hook; scoped via the list container's utility-class triple, see file header",
  }, { W1: obs });
  cx.close();
  return ok;
}

const CHECKS = { 1: search1, 2: search2, 3: search3, 4: search4, 5: search5, 6: search6 };

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`SEARCH-${n}`, 'ERROR', { error: e.message });
    results.push([n, false]);
  }
}
console.log(`\nSEARCH: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE HERE - `results.mjs` derives it from the VERDICTS, and these booleans are not the
// verdicts. Each one is the ASSERTION half only, computed before the observation was applied, so
// `process.exit(results.every(...))` reported 0 for a run whose every recorded row said PASS-DIRTY.
// Two sources of truth for one answer, and the one that exited was the one that had not looked.
