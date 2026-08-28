#!/usr/bin/env node
/**
 * WHAT A DEVICE IS STILL WAITING FOR, AND HOW LONG IT HAS BEEN WAITING - the reader every HEAL row
 * needs, and the one the HEAL-NEW rows are built on.
 *
 *   node syncrows.mjs --device W3                 one read, printed
 *   node syncrows.mjs --device W3 --watch 600     sample until every row is ready, or 600s
 *
 * THE QUESTION IT ANSWERS IS THE USER'S: does everything EVENTUALLY heal, and does the wait hurt
 * navigation. Both halves need TIME, not a snapshot - "12 rows syncing" is not a finding, "12 rows
 * syncing, 11 of them ready after 34s and one still amber after 10 minutes" is. So every sample
 * carries an elapsed offset AND a wall-clock stamp: the offset is what an assertion may use, the
 * stamp is what makes a sample correlatable with a console line, a logcat line or a server log when
 * the cause turns out to be on the other side of the wire. Nothing here ASSERTS on a wall clock -
 * that is forbidden and for good reason - it only records one.
 *
 * IT READS THREE THINGS, AND THE JOIN IS THE POINT:
 *
 *  - the SIDEBAR, via `data-conversation-tile` / `data-ready` / `data-removed`. Never the "Sync"
 *    badge's text: that is a Paraglide message, so counting it counts the translation, and the day
 *    the string moves the count silently becomes zero - which is the answer that makes a HEAL check
 *    pass over a broken app.
 *  - `GET /api/mls/users/:id/groups`, which is the one place a client learns which groups exist.
 *  - `GET /api/mls/users/:id/dismissed-groups`, the groups this user deliberately deleted or left
 *    on SOME device.
 *
 * The intersection of the last two is a population with a name: groups the user has said they want
 * gone, that the server still lists them as a member of. `discoverMissingGroups` consults the
 * dismissed set ONLY when a local row already exists, so on a device with an empty store - exactly
 * the state a new device is in - every one of them is re-created as a `pending` placeholder wearing
 * the Sync badge. That is the shape of the user's report: conversations marked SYNC that they had
 * deleted. Measuring it needs both lists, from the client's OWN session, so it is measured here.
 *
 * NO NAMES, EVER. This repository is public and the sidebar it reads is a real person's list of real
 * conversations. Rows are COUNTED, never labelled; group ids are cut to 8 characters, which is
 * enough to compare two reads and useless to anyone else. Whatever does need a display name goes
 * through `redact` first.
 */
import { pathToFileURL } from "node:url";
import { client, evaluate } from "./chat.mjs";
import { ORIGIN, PORTS } from "./names.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/** Eight characters: enough to compare two reads, useless to anyone else. */
export const cut = (s) => (typeof s === "string" && s.length > 8 ? s.slice(0, 8) : s || null);

/**
 * The sidebar's readiness, counted off the DOM hooks rather than off the badge's prose.
 *
 * `data-ready` is the string "true"/"false", not a boolean - a dataset value always is - so it is
 * compared as one. A tile carrying neither attribute is reported as `unhooked`: that is not zero
 * syncing rows, it is a reader that no longer matches the markup, and the two must never look alike.
 *
 * IT ALSO RETURNS THE ROWS THEMSELVES, BECAUSE A COUNT CANNOT ANSWER "WHICH". `tiles` is the same
 * information keyed by the groupId the hook now carries, and it exists for one question the counts
 * make unaskable: of the rows still amber, which are groups a device currently online could serve at
 * all? A responder is a member of some groups and not others, so "9 syncing" is a number with two
 * completely different meanings behind it. The counts stay, because every existing caller reads them
 * and a subset verdict must never quietly replace a total one.
 *
 * FULL IDS, NOT PREFIXES, AND THEY STOP AT THE PROCESS BOUNDARY. The join happens between two
 * BROWSER contexts - the fresh device's sidebar and the responder's group list - so it can only be
 * done in node, on values that came from both. Prefixes would make the join lossy in the one
 * direction that matters: two groups colliding on eight characters would add a group to the servable
 * set that the responder is NOT in, and the row would then demand a heal nobody could serve. So the
 * id travels whole in memory and is cut by `cut()` at every point where it is printed or recorded.
 */
const SIDEBAR = `(function () {
  var panel = document.querySelector('.sidebar-panel');
  if (!panel) return JSON.stringify({ panel: false });
  var tiles = [].slice.call(panel.querySelectorAll('[data-conversation-tile]'));
  var out = { panel: true, rows: tiles.length, ready: 0, syncing: 0, removed: 0, unhooked: 0, tiles: [] };
  tiles.forEach(function (t) {
    var r = t.getAttribute('data-ready');
    var rm = t.getAttribute('data-removed') === 'true';
    // An id is only absent if the markup lost the hook's value, which is a reader fault and is
    // reported as one rather than as a tile with no identity.
    out.tiles.push({ id: t.getAttribute('data-conversation-tile') || null, ready: r === 'true', removed: rm });
    if (rm) { out.removed++; return; }
    if (r === 'true') out.ready++;
    else if (r === 'false') out.syncing++;
    else out.unhooked++;
  });
  return JSON.stringify(out);
})()`;

/** How many rows the sidebar shows, hooked or not - the guard against reading an empty list. */
const ROWS_PRESENT = `!!document.querySelector('.sidebar-panel [data-conversation-tile]')`;

/** Reads the sidebar once. */
export async function sidebar(cx) {
  return JSON.parse(await evaluate(cx, SIDEBAR));
}

/**
 * The user id this client is logged in as, taken from what is ACTUALLY in the store.
 *
 * Derived from the `mls_device_id_<userId>` key rather than from any account file: the question is
 * who this DEVICE is, and an answer built from a name we already believed cannot contradict us.
 */
export async function whoAmI(cx) {
  const raw = await evaluate(
    cx,
    `(function () {
       var k = Object.keys(localStorage).find(function (x) { return x.indexOf('mls_device_id_') === 0; }) || '';
       return JSON.stringify({
         userId: k.slice('mls_device_id_'.length) || null,
         deviceId: k ? localStorage.getItem(k) : null,
       });
     })()`,
  );
  return JSON.parse(raw);
}

/**
 * The two server lists, and their intersection.
 *
 * Fetched with its own in-page request rather than through `apiGet`, for one reason: `apiGet` cuts
 * the body at 400 characters, which is right for reading a status and wrong for a list of groups -
 * a truncated JSON array does not fail, it PARSES SHORT, and a count taken from it is a count of
 * what fitted. So the projection happens in the page, and only the counts and the id prefixes come
 * back across.
 */
export async function serverView(cx, userId) {
  const raw = await evaluate(
    cx,
    `(async function () {
       var base = location.origin;
       function cut(s) { return typeof s === 'string' && s.length > 8 ? s.slice(0, 8) : s; }
       try {
         var r = await fetch(base + '/api/auth/refresh', { method: 'POST', credentials: 'include' });
         if (!r.ok) return JSON.stringify({ threw: 'refresh answered ' + r.status });
         var h = { Authorization: 'Bearer ' + (await r.json()).access_token };
         var u = ${JSON.stringify(encodeURIComponent(userId))};
         var g = await fetch(base + '/api/mls/users/' + u + '/groups', { headers: h });
         var d = await fetch(base + '/api/mls/users/' + u + '/dismissed-groups', { headers: h });
         if (!g.ok || !d.ok) return JSON.stringify({ threw: 'groups ' + g.status + ' dismissed ' + d.status });
         var groups = await g.json();
         var dismissed = await d.json();
         if (!Array.isArray(groups) || !Array.isArray(dismissed)) return JSON.stringify({ threw: 'not arrays' });
         var live = groups.filter(function (x) { return !x.deletedAt; });
         var ids = {};
         live.forEach(function (x) { ids[x.groupId] = true; });
         var both = dismissed.filter(function (id) { return ids[id]; });
         return JSON.stringify({
           active: live.length,
           tombstoned: groups.length - live.length,
           dismissed: dismissed.length,
           dismissedStillMember: both.length,
           dismissedStillMemberIds: both.map(cut),
         });
       } catch (e) {
         return JSON.stringify({ threw: String(e) });
       }
     })()`,
    { awaitPromise: true },
  );
  return JSON.parse(raw);
}

/**
 * The groups the server says this user is ACTIVELY a member of, by full id.
 *
 * WHY A SECOND READER AND NOT A FIELD ON `serverView`. `serverView`'s output is recorded, and its
 * ids are cut for that reason. This one exists to be JOINED - "which of the fresh device's amber
 * rows is a group the responder is in" - and a join on prefixes can invent a match that the world
 * does not contain. So the two are kept apart by their PURPOSE: this answer stays in memory, and
 * whatever a caller writes down it writes through `cut`.
 *
 * IT MUST BE ASKED OF THE RESPONDER'S OWN CLIENT. Membership is per user, and the token comes from
 * the cookie of the browser this connection points at - so passing a userId that is not that
 * browser's own gets a 403, correctly. The caller therefore reads the id from `whoAmI(cx)` on the
 * same connection rather than from any account file, exactly as `whoAmI`'s own doc argues.
 *
 * A read it cannot perform is `null`, never an empty list: "the responder is in no groups" and "the
 * question could not be asked" are the two answers a subset verdict must never confuse, because the
 * first makes a row unobservable and the second makes it unmeasured.
 */
export async function activeGroupIds(cx, userId) {
  const raw = await evaluate(
    cx,
    `(async function () {
       var base = location.origin;
       try {
         var r = await fetch(base + '/api/auth/refresh', { method: 'POST', credentials: 'include' });
         if (!r.ok) return JSON.stringify({ ids: null, why: 'refresh answered ' + r.status });
         var h = { Authorization: 'Bearer ' + (await r.json()).access_token };
         var u = ${JSON.stringify(encodeURIComponent(userId))};
         var g = await fetch(base + '/api/mls/users/' + u + '/groups', { headers: h });
         if (!g.ok) return JSON.stringify({ ids: null, why: 'groups answered ' + g.status });
         var groups = await g.json();
         if (!Array.isArray(groups)) return JSON.stringify({ ids: null, why: 'not an array' });
         return JSON.stringify({
           ids: groups.filter(function (x) { return !x.deletedAt; }).map(function (x) { return x.groupId; }),
           why: null,
         });
       } catch (e) {
         return JSON.stringify({ ids: null, why: String(e) });
       }
     })()`,
    { awaitPromise: true },
  );
  return JSON.parse(raw);
}

/**
 * Samples the sidebar until nothing is syncing any more, or the deadline passes.
 *
 * TERMINATION IS A PROOF, NEVER THE CLOCK: the loop ends when `syncing === 0`, and the deadline is
 * only there so a permanent placeholder is REPORTED rather than waited on forever. Which of the two
 * ended it is the whole verdict, so `settled` says so explicitly instead of leaving it to be
 * inferred from the elapsed time.
 *
 * Samples are kept only when the counts CHANGE. A 10-minute watch at 2s would otherwise be 300
 * identical rows, and a timeline nobody reads is a timeline that hides the one transition in it.
 *
 * `settledWhen` IS WHAT THE ROW IS WAITING FOR, AND THE DEFAULT IS ONLY THE COMMONEST ONE. Every
 * caller so far waits for the whole sidebar to go quiet, which is the right proof when a responder
 * is a member of every group. It is the WRONG one when the responder can serve a subset: the loop
 * then runs to its deadline every time and reports a stall that was never possible to avoid, which
 * is how HEAL-NEW-2 spent 600 s on 2026-08-28 to record a product FAIL about who was online. The
 * predicate is passed in rather than inferred, because only the caller knows which groups the world
 * it built could answer for - and TERMINATION IS STILL A PROOF: whatever the predicate, `settled`
 * says whether the loop ended on it or on the clock.
 *
 * THE SAMPLES CARRY CUT IDS, THE PREDICATE SEES WHOLE ONES. Samples are recorded in the ledger, and
 * `cut` is the rule for anything written down; the predicate runs in this process and needs the full
 * value to join against a server list. Both read the same sample, so a verdict can always be
 * re-derived from what was recorded, to eight characters.
 */
export async function watch(
  cx,
  {
    timeoutMs = 600_000,
    everyMs = 2000,
    log = () => {},
    settledWhen = (s) => s.panel && s.rows > 0 && s.syncing === 0 && s.unhooked === 0,
  } = {},
) {
  const t0 = Date.now();
  const samples = [];
  let last = null;
  let settled = false;
  for (;;) {
    const s = await sidebar(cx);
    const at = Date.now() - t0;
    const recordable = { ...s, tiles: (s.tiles ?? []).map((t) => ({ ...t, id: cut(t.id) })) };
    const key = JSON.stringify(recordable);
    if (key !== last) {
      const sample = { at, wall: new Date().toISOString(), ...recordable };
      samples.push(sample);
      log(`[syncrows] +${(at / 1000).toFixed(1)}s ${key}`);
      last = key;
    }
    if (settledWhen(s)) {
      settled = true;
      break;
    }
    if (Date.now() - t0 >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { settled, elapsedMs: Date.now() - t0, samples, final: samples.at(-1) ?? null };
}

/**
 * Whether the app is USABLE while it heals - the second half of the user's question.
 *
 * A heal that completes in ten minutes is acceptable; ten minutes of a frozen sidebar is not, and
 * the two are indistinguishable from a readiness count. So this measures the thing a person would
 * feel: how long a click on the conversation list takes to be honoured while rows are still amber.
 * It clicks the FIRST READY row - never a syncing one, which is expected to refuse - and times the
 * pane changing. A syncing app that cannot open a conversation it has already healed is the finding.
 */
export async function navigationCost(cx) {
  const t0 = Date.now();
  const before = await evaluate(
    cx,
    `(function () {
       var t = document.querySelector('.sidebar-panel [data-conversation-tile][data-ready="true"]');
       if (!t) return 'none';
       t.scrollIntoView({ block: 'center' });
       t.click();
       return 'clicked';
     })()`,
  );
  if (before !== "clicked") return { clicked: false, why: "no ready row to open" };
  const deadline = Date.now() + 20_000;
  for (;;) {
    const open = await evaluate(
      cx,
      `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`,
    );
    if (open === true || open === "true") return { clicked: true, openedInMs: Date.now() - t0 };
    if (Date.now() > deadline)
      return { clicked: true, openedInMs: null, why: "no composer in 20s" };
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** One full read: who the device is, what it shows, what the server says. */
export async function readAll(cx) {
  const who = await whoAmI(cx);
  const rows = await sidebar(cx);
  const server = who.userId ? await serverView(cx, who.userId) : { threw: "no user in the store" };
  return {
    wall: new Date().toISOString(),
    device: { user: cut(who.userId), device: cut(who.deviceId) },
    rows,
    server,
  };
}

// ---------------------------------------------------------------------------------------------
// Direct invocation: read, or read and watch. Read-only either way - nothing here mutates a client.
// ---------------------------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const device = opt("device", "W1");
  if (!PORTS[device]) throw new Error(`${device} is not declared in names.mjs`);
  const host = new URL(ORIGIN[device]).hostname;
  const cx = await client(PORTS[device], host);
  const first = await readAll(cx);
  console.log(`[syncrows] ${device} ${JSON.stringify(first)}`);
  const watchFor = opt("watch", null);
  if (watchFor) {
    const hooked = await evaluate(cx, ROWS_PRESENT);
    if (hooked !== true && hooked !== "true") {
      console.log("[syncrows] no hooked rows in the sidebar - nothing to watch");
    } else {
      const w = await watch(cx, {
        timeoutMs: Number(watchFor) * 1000,
        log: (m) => console.log(m),
      });
      console.log(
        `[syncrows] watch ${JSON.stringify({ settled: w.settled, elapsedMs: w.elapsedMs })}`,
      );
      console.log(`[syncrows] nav ${JSON.stringify(await navigationCost(cx))}`);
    }
  }
  cx.close();
  process.exit(0);
}
