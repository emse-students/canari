#!/usr/bin/env node
/**
 * GRAINE-AUTH-1..3 - a salon row the SERVER tampers with is REFUSED by the reader, with its line.
 *
 *   bun archive/graineauth.mjs --only 1    a relabelled row     (author mismatch)
 *   bun archive/graineauth.mjs --only 2    a moved row          (bad signature)
 *   bun archive/graineauth.mjs --only 3    a replayed ciphertext, at the door (409 CHANNEL_MESSAGE_KEY_REUSED)
 *
 * WHY THIS ROW EXISTS. Graine v2 (`channel-encryption.md` section 21) is a claim about an
 * ADVERSARIAL server: it may re-attribute, move or replay a salon row and the reader must not show it.
 * Every unit test of that claim feeds the reader a row built by the test. Nothing had ever shown a
 * REAL client, on a real estate, refusing a row a real writer produced and a database edit then
 * altered. *A green gate is not a working system.*
 *
 * THE TAMPERING IS A DATABASE EDIT AND NOTHING ELSE. The server is the adversary under test, so the
 * row is changed the way the server could change it - `UPDATE channel_messages` - after the owner
 * (W1) wrote it through the product and the peer (W2) had received it. W2 is then reloaded and
 * opens the salon again, which re-reads history: that is the path that must refuse. Every edit is
 * UNDONE in `finally`, so a killed run leaves the venue as the product wrote it.
 *
 * WHAT EACH ARM BINDS TO.
 *  1. `authorId` set to the peer's id. The session's minter is the owner, so the reader refuses:
 *     `[CHANNEL] ... REFUSED ... author mismatch`, at ERROR, and the marker is NOT in the pane.
 *  2. `messageIndex` + 1. The header `H` names the index, so the signature no longer verifies:
 *     `bad signature`. (The signature is checked BEFORE AES-GCM runs, which is what makes this class
 *     a refusal and not an unreadable row.)
 *  3. The same `(senderSessionId, messageIndex, nonce, ciphertext, signature)` POSTed again as the
 *     peer. Migration 065's UNIQUE index refuses it: HTTP 409 `CHANNEL_MESSAGE_KEY_REUSED` and
 *     `[CHANNEL_KEY_REUSED]` at ERROR in social-service. **THE READER'S OWN REPLAY REFUSAL
 *     (`GraineReplayError`) IS NOT REACHABLE FROM A LIVE ESTATE** - the index stops a second row
 *     existing - so it stays a unit test (`channelSeal` specs), and this arm proves the DOOR.
 *
 * NOT HERE: the seed relayed from a departed member (GRAINE-AUTH-4, board row, `pending`) - it needs
 * a member who has left the key group and a forged relay, and has no runner yet.
 *
 *   bun archive/graineauth.mjs --only 5    GRAINE-AUTH-5 AND -6, one injected row, read on W3
 *
 * 5 AND 6 - WHAT A MODIFIED CLIENT MINTING v1 GETS, now that an arriving v1 seed is refused
 * (channel-encryption section 21.7, G2-5b). The server still accepts an unsigned row (it cannot tell
 * a v1 session from a v2 one), so W1 POSTs, through the API and not the composer, exactly what such a
 * client would: an UNSIGNED row under a fresh session nobody holds. No seed is ever distributed for
 * it - a v1 seed would be refused anyway, which is the point.
 *  5. LIVE: the reader, salon open, says `REFUSED and not rendered - unsigned row under v1 session
 *     <id>` at ERROR, renders nothing, and ASKS NOBODY (no `[GRAINE] asked` line).
 *  6. HISTORY: the reader reloads and re-opens the salon. The page counts the row under `v1 session
 *     not held` at warn (a page replays honest pre-floor rows, so it accuses nobody), still asks
 *     nobody, and the salon shows the older-messages notice ONCE (`showing the older-messages
 *     notice`, and its text in the DOM).
 * The reader is W3, the owner's scratch device: any client lacks the injected session (it was never
 * distributed), and the live path has no own-author exit, so the account does not matter. The row is
 * DELETED in `finally`: left in place, every later history load of the venue would warn about it.
 * NO SIGNED CONTROL ARM, deliberately: a signed row under an unknown session DOES ask, and that ask
 * is a durable frame on the key group naming a session nobody minted - debris no `finally` can undo.
 * The control is `channelEventHandler.v1Live.test.ts` (the signed twin asks).
 *
 * A PRECONDITION IS ASSERTED, NOT ASSUMED: the row W1 just sent must carry a `signature`. An estate
 * still on a v1 writer would otherwise make every arm "pass" by refusing nothing to read.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { APP_TAB, apiPost, awaitMessage, countMessage, ensureChat, openChannel, send, client } from '../chat.mjs';
import { evaluate, reloadAndWait } from '../cdp.mjs';
import { channelIdOf, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { psql, srvLines } from '../estate.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from '../names.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import {
  awaitLine,
  consoleLines,
  gate,
  ignoringExpectedLog,
  ignoringExpectedRefusal,
  PAGE_BOOT_NARRATION,
  report,
  watch,
} from '../watch.mjs';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;
// 6 is not an arm of its own: it reads the history of the row 5 injected, so `--only 6` runs both.
const ARMS = only ? [only === 6 ? 5 : only] : [1, 2, 3, 5];
/** The client that reads the injected v1 row (arms 5 and 6): the owner's scratch device. */
const READER = 'W3';
const recordedIds = (n) => (n === 5 ? ['GRAINE-AUTH-5', 'GRAINE-AUTH-6'] : [`GRAINE-AUTH-${n}`]);

const workspaceId = workspaceIdOf(VENUE.community);
const channelId = workspaceId ? channelIdOf(workspaceId, VENUE.channel) : null;
const ownerId = userIdOf(OWNER_NAME);
const peerId = userIdOf(PEER_NAME);
if (!workspaceId || !channelId || !ownerId || !peerId) {
  for (const id of ARMS.flatMap(recordedIds)) {
    record(id, 'SETUP-FAILED', {
      setupFailed: `venue or accounts not found (community ${!!workspaceId}, salon ${!!channelId}, owner ${!!ownerId}, peer ${!!peerId}) - build the fixture with \`bun venue.mjs\``,
    });
  }
  exitOnRecorded();
}

const w1 = await client(PORTS.W1, APP_TAB);
// Arms 1-3 write through W1's composer and read on W2. Arms 5 and 6 only POST from W1's page, so
// they neither navigate W1 nor touch W2.
const composes = ARMS.some((n) => n <= 3);
const w2 = composes ? await client(PORTS.W2, APP_TAB) : null;
if (composes) {
  await ensureChat(w1);
  await openChannel(w1);
  await ensureChat(w2);
  await openChannel(w2);
}
const reader = ARMS.includes(5) ? await client(PORTS.W3, APP_TAB) : null;

/** The newest v2-looking row of the salon: `{ id, authorId, index, signed }` or null. */
function newestRow() {
  const out = psql(
    `SELECT id, "authorId", "messageIndex", signature IS NOT NULL FROM channel_messages ` +
      `WHERE "channelId" = '${channelId}' AND "senderSessionId" IS NOT NULL ` +
      `ORDER BY "createdAt" DESC LIMIT 1`
  ).trim();
  if (!out) return null;
  const [id, authorId, index, signed] = out.split('|');
  return { id, authorId, index: Number(index), signed: signed === 't' };
}

/** W1 writes one marker through the product; W2 must have it before anything is altered. */
async function sendAndAwait(label) {
  const marker = mark(`GAUTH-${label}`);
  await send(w1, marker);
  await awaitMessage(w2, marker, 30_000);
  const row = newestRow();
  return { marker, row };
}

/** Reloads W2 and opens the salon again, so history is read FROM THE SERVER. */
async function reopenOnW2(label) {
  await reloadAndWait(w2);
  const obs = await watch(w2, label);
  await ensureChat(w2);
  await openChannel(w2);
  return obs;
}

/** One tampering arm: edit, reload, look for the line and for the marker's absence, restore. */
async function tamperArm(n, { edit, undo, needle, companions = [] }) {
  const id = `GRAINE-AUTH-${n}`;
  const since = new Date().toISOString();
  const { marker, row } = await sendAndAwait(`${n}`);
  if (!row || row.authorId.toLowerCase() !== ownerId.toLowerCase() || !row.signed) {
    record(id, 'SETUP-FAILED', {
      setupFailed:
        'the row W1 just sent is not a signed row by the owner - the estate is not on the v2 writer ' +
        '(G2-5), or the newest row is not this run\'s',
      row: row && { authorId: '(read)', signed: row.signed },
    });
    return;
  }
  let edited = false;
  try {
    psql(edit(row));
    edited = true;
    const obs = await reopenOnW2(`graineauth-${n}`);
    const line = await awaitLine(w2, needle, 20_000);
    const shown = await countMessage(w2, marker);
    const unmet = [];
    if (!line) unmet.push(`theReaderNeverSaid(${needle})`);
    if (shown > 0) unmet.push('theTamperedRowWasRENDERED');
    const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
      W2: ignoringExpectedLog(await report(obs), [needle, 'is REFUSED and not rendered', 'REFUSED and not rendered', ...companions, ...PAGE_BOOT_NARRATION]),
    });
    record(id, gated.verdict, {
      ...gated.detail,
      unobservable:
        'the row is altered in the database on purpose - the REFUSED line it provokes is what this ' +
        'row reads, not noise it forgives',
      unmet,
      line: line ? line.slice(0, 240) : null,
      renderedCount: shown,
      serverSince: since,
    });
  } finally {
    if (edited) psql(undo(row));
  }
}

/** Arm 3: the door. The same sealed fields, sent again as the peer. */
async function replayArm() {
  const id = 'GRAINE-AUTH-3';
  const since = new Date().toISOString();
  const { row } = await sendAndAwait('3');
  if (!row || !row.signed) {
    record(id, 'SETUP-FAILED', { setupFailed: 'the row W1 just sent is not signed - the estate is not on the v2 writer' });
    return;
  }
  const fields = psql(
    `SELECT content, nonce, "senderSessionId", signature FROM channel_messages WHERE id = '${row.id}'`
  )
    .trim()
    .split('|');
  const [ciphertext, nonce, senderSessionId, signature] = fields;
  const before = psql(
    `SELECT count(*) FROM channel_messages WHERE "channelId" = '${channelId}'`
  ).trim();
  // W2 IS OBSERVED, because the replay is its request: the 409 it provokes is named below, and
  // anything else it says is dirt.
  const obs = await watch(w2, 'graineauth-3');
  const answer = await apiPost(w2, `/api/channels/${channelId}/messages`, {
    ciphertext,
    nonce,
    senderSessionId,
    messageIndex: row.index,
    signature,
  });
  const after = psql(`SELECT count(*) FROM channel_messages WHERE "channelId" = '${channelId}'`).trim();
  const log = srvLines('social-service', since).find((l) => l.includes('[CHANNEL_KEY_REUSED]')) ?? null;
  const unmet = [];
  if (answer.status !== 409 || !String(answer.body).includes('CHANNEL_MESSAGE_KEY_REUSED')) {
    unmet.push('theReplayWasNotAnswered409CHANNEL_MESSAGE_KEY_REUSED');
  }
  if (after !== before) unmet.push('aSecondRowWasSTORED');
  if (!log) unmet.push('noCHANNEL_KEY_REUSEDLineInSocialService');
  const replayPath = new RegExp(`^/api/channels/${channelId}/messages$`);
  const gated = gate(unmet.length ? 'FAIL' : 'PASS', {
    W2: ignoringExpectedRefusal(await report(obs), [{ path: replayPath, status: [409] }]),
  });
  record(id, gated.verdict, {
    ...gated.detail,
    unmet,
    status: answer.status,
    body: String(answer.body).slice(0, 160),
    rowsBefore: before,
    rowsAfter: after,
    serverLine: log && log.slice(0, 240),
  });
}

/** The notice's French text, read from the shipped catalogue so a rewording cannot blind the row. */
const NOTICE_TEXT = JSON.parse(
  await Bun.file(new URL('../../../frontend/messages/fr.json', import.meta.url)).text()
).chat_older_messages_unavailable;

/** How many times the reader's page shows `text`, after scrolling its transcript to the top. */
async function shownOnPage(cx, text) {
  return evaluate(
    cx,
    `(async function () {
      var list = document.querySelector('.chat-messages-scroll');
      for (var i = 0; list && i < 6; i++) {
        list.scrollTop = 0;
        await new Promise(function (r) { setTimeout(r, 400); });
      }
      return document.body.innerText.split(${JSON.stringify(text)}).length - 1;
    })()`
  );
}

/** Arms 5 and 6: one unsigned row under a session nobody holds, read live and then from history. */
async function v1Arms() {
  const sessionId = randomUUID();
  const since = new Date().toISOString();
  // A FRESH PAGE FIRST: the row is about the refusal the CURRENT build makes, and a tab left open
  // across a rebuild would answer with the code from before it.
  await reloadAndWait(reader);
  await ensureChat(reader);
  await openChannel(reader);
  const liveObs = await watch(reader, 'graineauth-5');
  const answer = await apiPost(w1, `/api/channels/${channelId}/messages`, {
    ciphertext: randomBytes(48).toString('base64'),
    nonce: randomBytes(12).toString('base64'),
    senderSessionId: sessionId,
    messageIndex: 0,
  });
  const rowId = psql(
    `SELECT id FROM channel_messages WHERE "channelId" = '${channelId}' AND "senderSessionId" = '${sessionId}'`
  ).trim();
  if (answer.status >= 300 || !rowId) {
    for (const id of recordedIds(5)) {
      record(id, 'SETUP-FAILED', {
        setupFailed: 'the server did not store the unsigned row W1 posted',
        status: answer.status,
        body: String(answer.body).slice(0, 160),
      });
    }
    return;
  }
  // The app's logger shortens an id to its first eight characters and an ellipsis, so the needle is
  // that prefix: the full id is never printed, and a needle spelling it matched nothing (2026-10-13).
  const shortId = sessionId.slice(0, 8);
  const refusal = `unsigned row under v1 session ${shortId}`;
  // A seed ask for THIS venue - not the history ask for another community a fresh page makes itself.
  const asked = (cx) =>
    consoleLines(cx).filter(
      (l) =>
        l.includes('[GRAINE] asked') &&
        l.includes(`seed(s) in community ${workspaceId.slice(0, 8)}`)
    );
  // Every line naming the injected session, whatever its level: what the reader decided about it.
  const aboutRow = (cx) => consoleLines(cx).filter((l) => l.includes(shortId));
  try {
    // ARM 5 - the live frame.
    const liveLine = await awaitLine(reader, refusal, 20_000);
    // The ask, when there is one, is one network hop behind the refusal; give it that hop.
    await new Promise((r) => setTimeout(r, 5_000));
    const liveAsks = asked(reader);
    const liveUnmet = [];
    if (!liveLine) liveUnmet.push('theReaderNeverRefusedTheLiveRow');
    else if (!liveLine.includes('is REFUSED and not rendered')) liveUnmet.push('theLiveRefusalWasNotAnERRORRefusal');
    if (liveAsks.length) liveUnmet.push('theLiveRowASKEDForASeed');
    const live = gate(liveUnmet.length ? 'FAIL' : 'PASS', {
      [READER]: ignoringExpectedLog(await report(liveObs), [refusal, ...PAGE_BOOT_NARRATION]),
    });
    record('GRAINE-AUTH-5', live.verdict, {
      ...live.detail,
      unobservable: 'the unsigned row is injected on purpose - its REFUSED line is what this row reads',
      unmet: liveUnmet,
      reader: READER,
      line: liveLine ? liveLine.slice(0, 240) : null,
      asks: liveAsks,
      aboutRow: aboutRow(reader),
      serverSince: since,
    });

    // ARM 6 - the same row, from history.
    await reloadAndWait(reader);
    const histObs = await watch(reader, 'graineauth-6');
    await ensureChat(reader);
    await openChannel(reader);
    // `watch` opened a new window, so the live arm's line (same words) cannot answer here. The page
    // line names its class and samples the per-row cause, which carries THIS session's id.
    const tallyLine = await awaitLine(reader, refusal, 20_000);
    const noticeLine = await awaitLine(reader, 'showing the older-messages notice', 5_000);
    await new Promise((r) => setTimeout(r, 5_000));
    const histAsks = asked(reader);
    const noticeShown = await shownOnPage(reader, NOTICE_TEXT);
    const histUnmet = [];
    if (!tallyLine) histUnmet.push('theHistoryPageNeverCountedTheInjectedRow');
    else if (!tallyLine.includes('v1 session not held')) histUnmet.push('theInjectedRowWasCountedUnderAnotherClass');
    else if (tallyLine.includes('REFUSED')) histUnmet.push('theHistoryPageACCUSEDAnHonestReplayClass');
    if (!noticeLine) histUnmet.push('theOlderMessagesNoticeWasNeverMade');
    if (noticeShown !== 1) histUnmet.push(`theNoticeIsShown${noticeShown}TimesNotOnce`);
    if (histAsks.length) histUnmet.push('theHistoryRowASKEDForASeed');
    const hist = gate(histUnmet.length ? 'FAIL' : 'PASS', {
      [READER]: ignoringExpectedLog(await report(histObs), [
        refusal,
        'showing the older-messages notice',
        ...PAGE_BOOT_NARRATION,
      ]),
    });
    record('GRAINE-AUTH-6', hist.verdict, {
      ...hist.detail,
      unobservable: 'the unsigned row is injected on purpose - the warn it provokes is what this row reads',
      unmet: histUnmet,
      reader: READER,
      line: tallyLine ? tallyLine.slice(0, 240) : null,
      noticeShown,
      asks: histAsks,
      aboutRow: aboutRow(reader),
      serverSince: since,
    });
  } finally {
    psql(`DELETE FROM channel_messages WHERE id = '${rowId}'`);
  }
}

try {
  for (const n of ARMS) {
    if (n === 1) {
      await tamperArm(1, {
        edit: (r) => `UPDATE channel_messages SET "authorId" = '${peerId}' WHERE id = '${r.id}'`,
        undo: (r) => `UPDATE channel_messages SET "authorId" = '${r.authorId}' WHERE id = '${r.id}'`,
        needle: 'author mismatch',
      });
    } else if (n === 2) {
      await tamperArm(2, {
        edit: (r) => `UPDATE channel_messages SET "messageIndex" = ${r.index + 1} WHERE id = '${r.id}'`,
        undo: (r) => `UPDATE channel_messages SET "messageIndex" = ${r.index} WHERE id = '${r.id}'`,
        needle: 'bad signature',
        // The WASM verifier's own WARN, emitted on the same refusal it provokes - the cause, not noise.
        companions: ['[GRAINE_SIG] signature does not verify'],
      });
    } else if (n === 3) {
      await replayArm();
    } else if (n === 5) {
      await v1Arms();
    }
  }
} finally {
  w1.close();
  w2?.close();
  reader?.close();
}

exitOnRecorded();
