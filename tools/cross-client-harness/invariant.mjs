#!/usr/bin/env bun
/**
 * THE INVARIANT PROBE EVERY MLS ROW RUNS AFTER ITS ACTION, ON EVERY CLIENT IN PLAY (R8).
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.0 lists five things every MLS row asserts
 * besides its own question: one tree, no stage left behind, a message after the event reaching every
 * member once, no forbidden line anywhere, and the roster agreeing with the tree. Written ONCE here,
 * not once per runner - the plan's own reason for R8. The JUDGEMENT is `invariantverdict.mjs`, pure
 * and self-tested; this file only collects, and says what it could not observe.
 *
 *   bun invariant.mjs --group <uuid> --device W1,W2 --to "<conversation>" --from-epoch 7 --since <ISO>
 *   bun invariant.mjs ... --members W1,W2      # W3 is in play but NOT a member (a removed device)
 *   bun invariant.mjs ... --reload             # then reload every web client and judge AGAIN
 *   bun invariant.mjs ... --expect-stage       # the row's subject IS a staged commit (OFF-*, KILL-*)
 *
 *   --group       the group the row moved
 *   --device      every client in play (`resolveDevices`; phones are armed first)
 *   --members     those that must hold the group; default: all of --device
 *   --to          the conversation, as the sidebar names it, where the post-event messages are sent
 *   --from-epoch  the server's activeEpoch BEFORE the row's action (`serverEpoch()` below reads it)
 *   --since       the row's own start, ISO: the server window is read from there
 *   --messages    how many post-event messages, default 2 (one cannot be out of order)
 *
 * A RUNNER calls {@link checkInvariant} and passes its OWN watchers (`watchers`), so the console of
 * the whole row is judged and not only the probe's few seconds: a web client keeps no console buffer
 * (`logs.mjs`), so the CLI alone can see only what is printed while it is attached, and it says so as
 * an approximation of invariant 4.
 *
 * THE RELOAD IS PART OF THE INVARIANT, not an option a row may skip when it is in a hurry: a state
 * held in memory and never saved passes the first pass and fails the second. Phones are NOT reloaded
 * (`goto`'s A1 rule: a reload re-locks the PIN and replaces the document under Tauri's IPC), and
 * that is recorded as an approximation of the second pass.
 *
 * REFUSES ANY ESTATE BUT LOCAL OR DEV, twice: `site.mjs` throws at import on production, and the
 * estate is re-asserted below so a future third estate is not judged by accident.
 *
 * EXIT CODE IS THE VERDICT: 0 every pass clean, 1 a failure, 2 a usage error.
 */
import { pathToFileURL } from 'node:url';
import { awaitAppReady, awaitMessage, client, ensureChat, openConversation, send, LOGIN_SHOWING } from './chat.mjs';
import { evaluate, reloadAndWait } from './cdp.mjs';
import { armIfPhone, resolveDevices, tabMatchFor } from './device.mjs';
import { psql, srvLines } from './estate.mjs';
import { closeOverlays } from './groupnav.mjs';
import { behindServer, invariantVerdict, settledRounds } from './invariantverdict.mjs';
import { ESTATE } from './site.mjs';
import { consoleEntries, watch } from './watch.mjs';

if (ESTATE !== 'local' && ESTATE !== 'dev') {
  throw new Error(`invariant.mjs runs on the local or the dev estate only, not '${ESTATE}'`);
}

/** The services whose window invariant 4 reads - the six `srvlog.mjs` reads. */
const SERVICES = ['chat-gateway', 'chat-delivery-service', 'core-service', 'media-service', 'social-service', 'call-service'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who this client is, from what is in its store (the `archive/syncrows.mjs` `whoAmI` reading). */
const WHO = `JSON.stringify((function () {
  var k = Object.keys(localStorage).find(function (x) { return x.indexOf('mls_device_id_') === 0; }) || '';
  return { userId: k.slice('mls_device_id_'.length) || null, deviceId: k ? localStorage.getItem(k) : null };
})())`;

/** The client's own `getEpoch` per group (`epochDevTools.ts`); `null` with the reason when absent. */
const EPOCHS = `JSON.stringify((function () {
  try {
    if (typeof window.__canariMlsEpochs !== 'function') return { epochs: null, why: 'no window.__canariMlsEpochs hook in this build' };
    return { epochs: window.__canariMlsEpochs(), why: null };
  } catch (e) { return { epochs: null, why: String(e) }; }
})())`;

/**
 * Every message row (`[data-own]`, `ChatMessageGroups.svelte`) carrying `marker`: how many, whether
 * it is OWN, its position among the rendered rows, and - for another's message - the sender the run
 * names (`a[href^="/profile/"]` of the nearest preceding non-own row that shows a sender; a DM shows
 * none, so `authorId` is null there and only own-ness is judged).
 */
const RECEIVED = (marker) => `JSON.stringify((function () {
  var rows = [].slice.call(document.querySelectorAll('[data-own]'));
  var hits = [];
  rows.forEach(function (r, i) {
    if ((r.innerText || '').indexOf(${JSON.stringify(marker)}) === -1) return;
    var own = r.getAttribute('data-own') === 'true';
    var author = null;
    if (!own) {
      for (var j = i; j >= 0; j--) {
        if (rows[j].getAttribute('data-own') === 'true') break;
        var a = rows[j].querySelector('a[href^="/profile/"]');
        if (a) { author = decodeURIComponent(a.getAttribute('href').slice('/profile/'.length)); break; }
      }
    }
    hits.push({ own: own, authorId: author, position: i });
  });
  return { count: hits.length, own: hits.length ? hits[0].own : null, authorId: hits.length ? hits[0].authorId : null, position: hits.length ? hits[0].position : undefined };
})())`;

/**
 * How one client shows `marker`: `{count, own, authorId, position}` - the reading invariant 3 takes,
 * exported so a row asserting its OWN messages (FLOOR-1) reads them the same way.
 */
export async function receivedOn(cx, marker) {
  return JSON.parse(await evaluate(cx, RECEIVED(marker)));
}

/** The 5xx answers a watched page received (`Network.responseReceived`), as `status url`. */
function http5xxOf(cx) {
  return (cx.consumed ?? [])
    .concat(cx.events)
    .filter((e) => e.method === 'Network.responseReceived' && e.params?.response?.status >= 500)
    .map((e) => `${e.params.response.status} ${String(e.params.response.url).slice(0, 120)}`);
}

/**
 * The server's view of `group` in ONE query: active epoch, commit-log epochs, roster, device seats.
 *
 * `awaitingAdmission` is read through `to_jsonb` so the query also runs on a build older than #2358,
 * where the column does not exist yet (dev before R7) and every row is simply not awaiting.
 */
export function serverView(group) {
  if (!UUID.test(group)) throw new Error(`--group '${group}' is not a uuid`);
  const sql =
    `SELECT json_build_object(` +
    `'activeEpoch', (SELECT "activeEpoch" FROM dm_groups WHERE id = '${group}'), ` +
    `'commitEpochs', (SELECT coalesce(json_agg("baseEpoch" ORDER BY "baseEpoch"), '[]'::json) FROM mls_commit_log WHERE "groupId" = '${group}'), ` +
    `'roster', (SELECT coalesce(json_agg(json_build_object('userId', m."userId", 'awaitingAdmission', coalesce((to_jsonb(m) ->> 'awaitingAdmission')::boolean, false))), '[]'::json) FROM dm_group_members m WHERE m."groupId" = '${group}'), ` +
    `'seats', (SELECT coalesce(json_agg(json_build_object('userId', d."userId", 'deviceId', d."deviceId", 'status', d.status, 'kicked', d."kickedAt" IS NOT NULL)), '[]'::json) FROM dm_device_group_memberships d WHERE d."groupId" = '${group}'))`;
  return JSON.parse(psql(sql));
}

/** The server's `activeEpoch` for `group` - what a row records as `fromEpoch` BEFORE its action. */
export const serverEpoch = (group) => serverView(group).activeEpoch;

/** Every service's window since `since`; an unreachable one is a reason, never an empty window. */
function serverWindow(since) {
  const lines = [];
  for (const s of SERVICES) {
    try {
      lines.push(...srvLines(s, since));
    } catch (e) {
      return { lines: null, unreachable: `${s}: ${String(e?.message ?? e).slice(0, 160)}` };
    }
  }
  return { lines, unreachable: null };
}

/** One client's readings for one pass. */
async function readClient(slot, group, markers, provoked) {
  const { cx, target } = slot;
  const who = JSON.parse(await evaluate(cx, WHO));
  const ep = JSON.parse(await evaluate(cx, EPOCHS));
  const loggedOut = (await evaluate(cx, LOGIN_SHOWING)) === true;
  const received = [];
  if (slot.member && markers.length) {
    for (const m of markers) {
      // A MISS IS THE VERDICT'S TO JUDGE (count 0), so it is not thrown - but it is printed with the
      // pane state `awaitMessage` attaches, which is what separates absent, late and scrolled away.
      await awaitMessage(cx, m, 20_000).catch((e) => console.log(`[invariant] ${target.device}: ${String(e?.message ?? e).slice(0, 300)}`));
      received.push({ marker: m, ...JSON.parse(await evaluate(cx, RECEIVED(m))) });
    }
  }
  return {
    device: target.device ?? String(target.port),
    userId: who.userId,
    deviceId: who.deviceId,
    member: slot.member,
    epochs: ep.epochs,
    epochsWhy: ep.why,
    loggedOut,
    // The row's watcher holds the whole row; a probe-only watcher holds the probe, which is still
    // evidence - and `rowWatched: false` makes the verdict say which of the two was judged.
    lines: consoleEntries(cx),
    rowWatched: slot.rowWatched,
    http5xx: http5xxOf(cx),
    provoked5xx: provoked[target.device] ?? [],
    received,
    // Not readable from the page on this build - `invariantverdict.mjs` records the approximation.
    fingerprint: undefined,
    pendingSubmission: undefined,
    leafUsers: undefined,
  };
}

/**
 * Waits, after the reload, for the group to SETTLE (`settledRounds`): the server's epoch and every
 * member's agree on two rounds in a row - re-reading the server each round, since a reloaded client's
 * connection may itself commit (`behindServer`). The bound is an ABORT, never a verdict: a group that
 * never settled is unjudged, and the pass says why (`unsettled`).
 *
 * @returns {Promise<{ms: number, settled: boolean, rounds: {serverEpoch: number|null, behind: string[]}[]}>}
 */
async function awaitSettled(members, group, abortMs = 60_000) {
  const started = Date.now();
  const rounds = [];
  for (;;) {
    const epochs = {};
    for (const s of members) epochs[s.target.device ?? String(s.target.port)] = JSON.parse(await evaluate(s.cx, EPOCHS)).epochs;
    const serverEpoch = serverView(group).activeEpoch;
    rounds.push({ serverEpoch, behind: behindServer(epochs, group, serverEpoch) });
    const ms = Date.now() - started;
    if (settledRounds(rounds)) return { ms, settled: true, rounds };
    if (ms > abortMs) return { ms, settled: false, rounds };
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Run the invariant over every client in play.
 *
 * @param {object} p
 * @param {string} p.group
 * @param {{device: string, port: number, isPhone: boolean}[]} p.targets every client in play
 * @param {string[]} [p.members] device names that must hold the group; default all
 * @param {string|Record<string, string>} p.conversation where the post-event messages go, as the
 *   sidebar names it: one name for all, or one per device (a DM shows each side the other person)
 * @param {number|null} p.fromEpoch the server epoch before the row's action
 * @param {string} p.since ISO start of the row
 * @param {boolean} [p.reload]
 * @param {boolean} [p.expectStage]
 * @param {number} [p.messages]
 * @param {Record<string, object>} [p.watchers] device -> the row's own `watch()` result, attached since the row began
 * @param {Record<string, {status: number|null, url: string}[]>} [p.provoked] device -> the failures the row's OWN
 *   faults put in front of that page (`rowkit.mjs` `provokedFailures`); invariant 4 forgives each 5xx ONCE
 * @returns {Promise<{ok: boolean, passes: object[]}>}
 */
export async function checkInvariant({ group, targets, members, conversation, fromEpoch, since, reload = false, expectStage = false, messages = 2, watchers = {}, provoked = {} }) {
  if (!UUID.test(group)) throw new Error(`group '${group}' is not a uuid`);
  if (!conversation) throw new Error('a conversation to send the post-event messages in is required - invariant 3 is not optional');
  const memberSet = new Set(members?.length ? members : targets.map((t) => t.device));
  // A DM IS NAMED DIFFERENTLY ON EACH SIDE - each sidebar shows the OTHER person - so a row may hand
  // one name per device instead of one for all (FLOOR-1).
  const conversationOf = (device) => {
    const name = typeof conversation === 'string' ? conversation : conversation[device];
    if (!name) throw new Error(`no conversation name for member ${device} - pass a string, or a name per device`);
    return name;
  };

  const slots = [];
  for (const target of targets) {
    await armIfPhone(target, `invariant:${target.device}`);
    const own = watchers[target.device];
    const cx = own?.cx ?? (await client(target.port, tabMatchFor(target)));
    // A CLIENT THE ROW DID NOT WATCH is watched from now: the probe's own window is judged, and the
    // row's window is an approximation recorded by the verdict (`lines: null` until here).
    if (!own) await watch(cx, `invariant:${target.device}`);
    slots.push({ cx, target, member: memberSet.has(target.device), rowWatched: !!own });
  }

  // ── the post-event messages, from the first member, in order ──────────────────────────────────
  const sender = slots.find((s) => s.member);
  if (!sender) throw new Error('no member device in play');
  for (const s of slots.filter((x) => x.member)) {
    // THE ROW'S ACTION MAY LEAVE A PANEL OPEN - FLOOR-2's bulk Add ended on the group's side panel,
    // whose scrim covers the sidebar below `xl`, and the tile click below died on it (2026-10-25).
    // The probe starts from a clear surface on every member rather than trusting each runner to.
    await closeOverlays(s.cx);
    await ensureChat(s.cx);
    await openConversation(s.cx, conversationOf(s.target.device));
  }
  const authorId = JSON.parse(await evaluate(sender.cx, WHO)).userId;
  const markers = [];
  for (let i = 0; i < messages; i++) {
    const marker = `inv${Date.now().toString(36)}${i}`;
    await send(sender.cx, `invariant ${i + 1}/${messages} [${marker}]`);
    await awaitMessage(sender.cx, marker, 20_000);
    markers.push(marker);
  }

  const judge = async (label) => {
    const clients = [];
    for (const s of slots) clients.push(await readClient(s, group, markers, provoked));
    const win = serverWindow(since);
    const verdict = invariantVerdict({
      group,
      fromEpoch,
      expectStage,
      clients,
      server: { ...serverView(group), lines: win.lines, unreachable: win.unreachable },
      message: { markers, authorId },
    });
    return { pass: label, ...verdict };
  };

  const passes = [await judge('after the action')];
  if (reload) {
    const notReloaded = [];
    for (const s of slots) {
      if (s.target.isPhone) {
        notReloaded.push(s.target.device);
        continue;
      }
      await reloadAndWait(s.cx);
      await awaitAppReady(s.cx);
      if (s.member) {
        await ensureChat(s.cx);
        await openConversation(s.cx, conversationOf(s.target.device));
      }
    }
    const label = 'after a reload of every web client';
    const settled = await awaitSettled(slots.filter((s) => s.member), group);
    // A GROUP THAT NEVER SETTLED IS NOT JUDGED: the abort is a timer, and a timer may not decide a
    // verdict. The pass carries the reason and `composeVerdict` makes the row INCONCLUSIVE.
    const last = settled.rounds.at(-1);
    const second = settled.settled
      ? await judge(label)
      : {
          pass: label,
          ok: false,
          failures: [],
          approximations: [],
          unsettled: `the group never settled after the reload (${settled.ms} ms, ${settled.rounds.length} round(s); last: server at ${last?.serverEpoch}, behind: ${last?.behind.join(' ') || 'nobody'})`,
        };
    second.settleMs = settled.ms;
    if (notReloaded.length) {
      second.approximations.push({ invariant: 0, what: `not reloaded (a phone reload re-locks the PIN and replaces the document under Tauri IPC): ${notReloaded.join(' ')}` });
    }
    passes.push(second);
  }
  return { ok: passes.every((p) => p.ok), passes };
}

/** Print one result the way a reader scans it: verdict, then each failure, then each approximation. */
export function printInvariant(result) {
  for (const p of result.passes) {
    console.log(`[invariant] ${p.pass}: ${p.ok ? 'CLEAN' : `${p.failures.length} FAILURE(S)`}`);
    for (const f of p.failures) console.log(`  FAIL  (${f.invariant}) ${f.what}`);
    for (const a of p.approximations) console.log(`  APPROX (${a.invariant}) ${a.what}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const group = opt('group');
  const since = opt('since');
  const conversation = opt('to');
  if (!group || !since || !conversation) {
    console.error('usage: bun invariant.mjs --group <uuid> --device W1,W2 --to "<conversation>" --from-epoch N --since <ISO> [--members ...] [--reload] [--expect-stage]');
    process.exit(2);
  }
  const fromRaw = opt('from-epoch');
  const result = await checkInvariant({
    group,
    targets: resolveDevices(argv),
    members: opt('members')?.split(',').map((s) => s.trim()).filter(Boolean),
    conversation,
    fromEpoch: fromRaw === null ? null : Number(fromRaw),
    since,
    reload: argv.includes('--reload'),
    expectStage: argv.includes('--expect-stage'),
    messages: Number(opt('messages') ?? 2),
  });
  printInvariant(result);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
