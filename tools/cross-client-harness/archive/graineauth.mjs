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
 * A PRECONDITION IS ASSERTED, NOT ASSUMED: the row W1 just sent must carry a `signature`. An estate
 * still on a v1 writer would otherwise make every arm "pass" by refusing nothing to read.
 */
import { APP_TAB, apiPost, awaitMessage, countMessage, ensureChat, openChannel, send, client } from '../chat.mjs';
import { reloadAndWait } from '../cdp.mjs';
import { channelIdOf, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { psql, srvLines } from '../estate.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from '../names.mjs';
import { exitOnRecorded, mark, record } from '../results.mjs';
import { awaitLine, gate, ignoringExpectedLog, report, watch } from '../watch.mjs';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;
const ARMS = only ? [only] : [1, 2, 3];

const workspaceId = workspaceIdOf(VENUE.community);
const channelId = workspaceId ? channelIdOf(workspaceId, VENUE.channel) : null;
const ownerId = userIdOf(OWNER_NAME);
const peerId = userIdOf(PEER_NAME);
if (!workspaceId || !channelId || !ownerId || !peerId) {
  for (const n of ARMS) {
    record(`GRAINE-AUTH-${n}`, 'SETUP-FAILED', {
      setupFailed: `venue or accounts not found (community ${!!workspaceId}, salon ${!!channelId}, owner ${!!ownerId}, peer ${!!peerId}) - build the fixture with \`bun venue.mjs\``,
    });
  }
  exitOnRecorded();
}

const w1 = await client(PORTS.W1, APP_TAB);
const w2 = await client(PORTS.W2, APP_TAB);
await ensureChat(w1);
await ensureChat(w2);
await openChannel(w1);
await openChannel(w2);

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
async function tamperArm(n, { edit, undo, needle }) {
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
      W2: ignoringExpectedLog(await report(obs), [needle, 'is REFUSED and not rendered', 'REFUSED and not rendered']),
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
  record(id, unmet.length ? 'FAIL' : 'PASS', {
    unmet,
    status: answer.status,
    body: String(answer.body).slice(0, 160),
    rowsBefore: before,
    rowsAfter: after,
    serverLine: log && log.slice(0, 240),
  });
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
      });
    } else if (n === 3) {
      await replayArm();
    }
  }
} finally {
  w1.close();
  w2.close();
}

exitOnRecorded();
