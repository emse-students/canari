/**
 * THE ADMISSION ROWS OF THE 1.4.1 CAMPAIGN - a group link, the ask it raises, and who may answer it.
 *
 *   bun archive/admit.mjs --row ADM-1|ADM-2|ADM-3|ADM-4|ADM-8|ADM-9|ADM-10   # browsers
 *   bun archive/admit.mjs --row ADM-5|ADM-6|ADM-7               # A1 on the v1.4.0 APK (class B)
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table, the waiting seat's route table
 * and every judge are `admitrows.mjs`, the gestures `archive/grouplink.mjs`. ADM-5..7 REFUSE to judge
 * a phone that is not running the old build: the install is the operator's (`bun a1apk.mjs --no-build
 * --accept-dead-production-literal` with the recorded `v1.4.0` APK, then R2's APK back), and the row
 * reads A1's own `/_app/version.json` and compares its commit with the tag's.
 *
 * THE LINK'S TOKEN IS NEVER RECORDED - a join capability, in a public repository. Its length is.
 */
import { execFileSync } from 'node:child_process';
import {
  ADMISSION_ENDINGS,
  ADMIT_ROWS,
  OLD_REF,
  admittedOwn,
  baseWithheldRepeats,
  declinedOwn,
  gateRefusals,
  memberRoutes,
  noAskOwn,
  oldBuildOwn,
  oldMemberOwn,
  outsiderOwn,
  probeOwn,
  raceOwn,
  rateLimitedOwn,
  reinviteOwn,
  routeEnrolments,
  seatState,
  staleAddOwn,
} from '../admitrows.mjs';
import { apiAt, apiGet, apiPost, evaluate, goto, send } from '../chat.mjs';
import { psql, srvLines } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { awaitSettled, checkInvariant, receivedOn } from '../invariant.mjs';
import {
  COMMIT_POST,
  assertRowOwns,
  awaitListed,
  awaitServer,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  USER_ID,
  watchersOf,
} from '../mlsrow.mjs';
import { clientBuild, errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { commitSequence } from '../settlerows.mjs';
import { SITE } from '../site.mjs';
import { GROUP_CREATION_NARRATION, admissionJoinerNarration, admissionMemberNarration, consoleLines } from '../watch.mjs';
import { addMembers } from './addmember.mjs';
import { answerAsk, awaitAsk, awaitAskGone, followGroupLink, mintGroupLink } from './grouplink.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!ADMIT_ROWS[id]) {
  console.error(`usage: bun archive/admit.mjs --row ${Object.keys(ADMIT_ROWS).join('|')}`);
  process.exit(2);
}
const spec = ADMIT_ROWS[id];
const since = new Date().toISOString();
let seats = null;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `predicate` once a second until it holds; rejects at the abort, which is never a verdict. */
async function until(predicate, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(1_000);
  }
}
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The commit the old tag names, from this checkout's own tags - never typed. */
function oldCommit() {
  try {
    return execFileSync('git', ['rev-parse', `${OLD_REF}^{commit}`], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The ask lines `[JOIN_REQUEST] <user> asks to join <g8>...` a member printed about `groupId`. */
const askLinesOn = (cx, groupId) => consoleLines(cx).filter((l) => l.includes('[JOIN_REQUEST]') && l.includes(`asks to join ${String(groupId).slice(0, 8)}`)).length;

/**
 * The refusals THIS row provokes on purpose, per device - handed to `observersOf` so a status the
 * row asked for is not counted as the product's dirt. Each is added at the gesture that provokes it,
 * so a row that never reached the gesture forgives nothing.
 */
const rowRefusals = {};
const expectRefusal = (device, rule) => (rowRefusals[device] ??= []).push(rule);

/**
 * Asks the base as `seat` - from its own page; a phone names the estate's API origin. A waiting seat
 * is answered 409 (`awaiting_admission`), which is what every waiting row asserts, so that 409 is
 * the row's own and forgiven on this seat - at 409 only.
 */
const baseAs = (seat, groupId) => {
  expectRefusal(seat.target.device, { path: new RegExp(`^/api/mls/group-info/${groupId}$`), status: [409] });
  return seat.target.isPhone ? apiAt(seat.cx, SITE, 'GET', `/api/mls/group-info/${groupId}`) : apiGet(seat.cx, `/api/mls/group-info/${groupId}`);
};

/** Waits for the joiner's seat to reach `state` on the server; its state then. */
async function seatReaches(c, user, state, timeoutMs) {
  await awaitServer(c.group.id, (v) => seatState(v, user).state === state && (state !== 'admitted' || seatState(v, user).active > 0), timeoutMs);
  return seatState(serverView(c.group.id), user);
}

/** The joiner follows the link and is left waiting; the facts the waiting rows share. */
async function followAndWait(c) {
  const J = seats.seat[spec.joiner];
  const follow = await outcome(followGroupLink(J.cx, c.link));
  const waitingSeat = (await seatReaches(c, c.user[spec.joiner], 'waiting', 30_000)).state;
  const base = await baseAs(J, c.group.id);
  await goto(J.cx, '/chat');
  return { follow, waitingText: follow.ok ? follow.value.waitingText : false, waitingSeat, base };
}

/** Every member's screen, polled for the ask. */
async function asksOn(c, devices) {
  const out = {};
  for (const d of devices) out[d] = await awaitAsk(seats.seat[d].cx, c.user[spec.joiner], 90_000);
  return out;
}

/**
 * The answer, given only where the ask SHOWED. An answerer whose screen never showed it is already a
 * failed assertion (`<seat> shows the ask (never)`); throwing from `answerAsk` turned that FAIL into
 * an ERROR with no verdict (ADM-1, 2026-10-25: the ask reached the one member its request was
 * forwarded to, and W1 - the answerer - only at its next connection).
 *
 * @returns {Promise<boolean>} whether the answer was given
 */
async function answerWhereShown(asks, by, userId, choice) {
  if (asks[by] === null) {
    console.log(`[${id}] ${by} never showed the ask - no answer given, the judge records it`);
    return false;
  }
  await answerAsk(seats.seat[by].cx, userId, choice);
  return true;
}

const ACTIONS = {
  /** ADM-1: waiting, refused the base, asked everywhere, admitted by one member, the ask gone everywhere. */
  async 'ADM-1'(c) {
    const w = await followAndWait(c);
    const asks = await asksOn(c, c.members);
    await answerWhereShown(asks, spec.answer.by, c.user[spec.joiner], spec.answer.choice);
    const admitted = await seatReaches(c, c.user[spec.joiner], 'admitted', 60_000);
    const listed = (await awaitListed(seats.seat[spec.joiner].cx, c.group.name, 90_000)) !== null;
    const gone = {};
    for (const d of c.members) gone[d] = await awaitAskGone(seats.seat[d].cx, c.user[spec.joiner], 120_000);
    return {
      members: [...c.members, spec.joiner],
      detail: { follow: w.follow, base: w.base?.status, asks, gone },
      judge: () => admittedOwn({ ...w, asks, admitted, listed, gone }),
    };
  },

  /** ADM-2: a member Declines; withdrawn and nothing more. */
  async 'ADM-2'(c) {
    const w = await followAndWait(c);
    const asks = await asksOn(c, c.members);
    await answerWhereShown(asks, spec.answer.by, c.user[spec.joiner], spec.answer.choice);
    const after = await seatReaches(c, c.user[spec.joiner], 'absent', 60_000);
    const exclusions = await apiGet(seats.seat[c.owner].cx, `/api/mls/groups/${c.group.id}/exclusions`);
    const excluded = String(exclusions.body ?? '').toLowerCase().includes(c.user[spec.joiner].toLowerCase());
    const mark = rowMessageMark(id, 'AFTER');
    await send(seats.seat[c.owner].cx, `${id} after the Decline [${mark}]`);
    const J = seats.seat[spec.joiner].cx;
    const listed = (await awaitListed(J, c.group.name, 20_000)) !== null;
    let shown = 0;
    if (listed) {
      await openGroup(J, c.group.name, { label: id });
      shown = (await receivedOn(J, mark)).count;
    }
    return {
      members: c.members,
      detail: { follow: w.follow, asks, exclusionsStatus: exclusions.status },
      judge: () => declinedOwn({ asks, after, excluded, listed, shown }),
    };
  },

  /** ADM-9: declined, then a NEW link, waiting again, and the Add built after the Decline admits. */
  async 'ADM-9'(c) {
    const { decline, approve } = spec.reinvite;
    await followAndWait(c);
    const firstAsks = await asksOn(c, c.members);
    await answerWhereShown(firstAsks, decline, c.user[spec.joiner], 'decline');
    const declined = await seatReaches(c, c.user[spec.joiner], 'absent', 60_000);
    // A NEW LINK, minted after the Decline: the old one is the ask that was answered.
    c.link = await mintGroupLink(seats.seat[c.owner].cx, c.group.name);
    await closeOverlays(seats.seat[c.owner].cx);
    const again = await followAndWait(c);
    const asks = await asksOn(c, c.members);
    await answerWhereShown(asks, approve, c.user[spec.joiner], 'approve');
    const admitted = await seatReaches(c, c.user[spec.joiner], 'admitted', 60_000);
    const listed = (await awaitListed(seats.seat[spec.joiner].cx, c.group.name, 90_000)) !== null;
    return {
      members: admitted.state === 'admitted' ? [...c.members, spec.joiner] : c.members,
      detail: { firstAsks, asks, follow: again.follow },
      judge: () => reinviteOwn({ declined, rewaiting: again.waitingSeat, asks, admitted, listed }),
    };
  },

  /** ADM-10: the Add's commit held, the Decline settled, then the Add released - it admits nobody. */
  async 'ADM-10'(c) {
    const { approve, decline } = spec.stale;
    await followAndWait(c);
    const asks = await asksOn(c, c.members);
    const A = seats.seat[approve];
    const fa = await armFault(A.cx, [{ ...COMMIT_POST, fault: 'hold once' }]);
    await answerAsk(A.cx, c.user[spec.joiner], 'approve');
    const held = await outcome(fa.awaitHeld(1, 45_000));
    // THE DECLINE LANDS AND SETTLES WHILE THE ADD IS HELD: that order is the whole row.
    await answerWhereShown(asks, decline, c.user[spec.joiner], 'decline');
    const declined = await seatReaches(c, c.user[spec.joiner], 'absent', 60_000);
    await fa.release();
    // THE RELEASED COMMIT IS DECIDED FIRST, then the group settles BY ROUNDS (`awaitSettled`): the
    // joiner's state is sampled on every round, so "never admitted" covers the whole settlement and
    // no clock decides it. The held commit is the only one since the row began, so any decision on
    // the group is its decision.
    const decided = await outcome(until(() => commitSequence(commitLines(c.group.id, c.startSince)).length > 0, "the released commit's decision", 45_000));
    const joinerUser = c.user[spec.joiner];
    const settled = await awaitSettled(
      c.members.map((d) => seats.seat[d]),
      c.group.id,
      60_000,
      () => ({ joiner: seatState(serverView(c.group.id), joinerUser).state })
    );
    const trail = settled.rounds.map((r) => r.joiner);
    const records = await fa.disarm();
    const after = seatState(serverView(c.group.id), joinerUser);
    const listed = (await awaitListed(seats.seat[spec.joiner].cx, c.group.name, 5_000)) !== null;
    const lines = srvLines('chat-delivery-service', c.startSince);
    const gateRefused = gateRefusals(lines, c.group.id, joinerUser);
    const routeEnrolled = routeEnrolments(lines, c.group.id, joinerUser);
    // AN ADMITTED SAMPLE IS A FINDING SETTLED OR NOT; a group that never settled with none is unjudged.
    const unjudged = !decided.ok
      ? [`the released commit was never decided: ${decided.error}`]
      : !settled.settled && !trail.includes('admitted')
        ? [`the group never settled after the release (${settled.ms} ms, ${settled.rounds.length} round(s))`]
        : [];
    return {
      members: after.state === 'admitted' ? [...c.members, spec.joiner] : c.members,
      records: { [approve]: records.records },
      unjudged,
      detail: { asks, trail, settleMs: settled.ms, settled: settled.settled, rounds: settled.rounds.length },
      judge: () => staleAddOwn({ held, declined, trail, after, listed, gateRefused, routeEnrolled }),
    };
  },

  /** ADM-3: the Add's commit and the Decline's request held on their seats, released together. */
  async 'ADM-3'(c) {
    await followAndWait(c);
    const asks = await asksOn(c, c.members);
    const A = seats.seat[spec.race.approve];
    const D = seats.seat[spec.race.decline];
    const fa = await armFault(A.cx, [{ ...COMMIT_POST, fault: 'hold once' }]);
    const fd = await armFault(D.cx, [{ match: `/api/mls/groups/${c.group.id}/join-requests/`, method: 'POST', fault: 'hold once' }]);
    await answerAsk(A.cx, c.user[spec.joiner], 'approve');
    await answerAsk(D.cx, c.user[spec.joiner], 'decline');
    const outcomes = {};
    outcomes[spec.race.approve] = await outcome(fa.awaitHeld(1, 45_000));
    outcomes[spec.race.decline] = await outcome(fd.awaitHeld(1, 45_000));
    const releasedAt = now();
    await Promise.all([fa.release(), fd.release()]);
    const J = seats.seat[spec.joiner].cx;
    const listedTrail = [];
    for (let i = 0; i < 30; i++) {
      listedTrail.push((await awaitListed(J, c.group.name, 1_000)) !== null);
      await sleep(1_000);
    }
    const ra = await fa.disarm();
    const rd = await fd.disarm();
    const after = seatState(serverView(c.group.id), c.user[spec.joiner]);
    return {
      members: after.state === 'admitted' ? [...c.members, spec.joiner] : c.members,
      records: { [spec.race.approve]: ra.records, [spec.race.decline]: rd.records },
      detail: { asks, releasedAt, final: after },
      judge: () => raceOwn({ outcomes, after, listedTrail }),
    };
  },

  /** ADM-4: the waiting seat calls every member route; then a member Declines, leaving the group clean. */
  async 'ADM-4'(c) {
    await followAndWait(c);
    const J = seats.seat[spec.joiner].cx;
    const W5 = seats.seat.W5.cx;
    const routes = memberRoutes(c.group.id, { enrolUser: c.user.W5, vouchUser: c.user.W5, vouchDevice: await deviceIdOf(W5, c.user.W5) });
    const answers = [];
    for (const r of routes) {
      const a = r.method === 'GET' ? await apiGet(J, r.path) : await apiPost(J, r.path, r.body);
      answers.push({ what: r.what, method: r.method, status: a.status, threw: a.threw, body: String(a.body ?? '').slice(0, 120) });
    }
    const view = serverView(c.group.id);
    const after = seatState(view, c.user[spec.joiner]);
    const enrolled = seatState(view, c.user.W5).state;
    // THE ASK IS ANSWERED SO THE GROUP ENDS AS IT BEGAN; the answer is not what this row judges.
    await awaitAsk(seats.seat[c.owner].cx, c.user[spec.joiner], 90_000);
    await answerAsk(seats.seat[c.owner].cx, c.user[spec.joiner], 'decline').catch((e) => console.log(`[${id}] the closing Decline: ${String(e?.message ?? e)}`));
    // EVERY PROBE IS THE ROW'S OWN and answers 409 by design: forgiven route by route, at 409 only, so
    // a route that answered anything else stays dirt beside its failed assertion. The paths are
    // `/api/...` with a uuid - no character in them is special to a RegExp.
    for (const r of routes) expectRefusal(spec.joiner, { path: new RegExp(`^${r.path}$`), status: [409] });
    return {
      members: c.members,
      detail: { answers: answers.map(({ body: _body, ...a }) => a) },
      judge: () => probeOwn({ answers, after, enrolled }),
    };
  },

  /** ADM-5: the OLD joiner meets the withheld base, asks, and a member's Add admits it. */
  async 'ADM-5'(c) {
    const w = await followAndWait(c);
    const asks = await asksOn(c, c.members);
    await answerWhereShown(asks, spec.answer.by, c.user[spec.joiner], spec.answer.choice);
    const admitted = await seatReaches(c, c.user[spec.joiner], 'admitted', 90_000);
    const listed = (await awaitListed(seats.seat[spec.joiner].cx, c.group.name, 120_000)) !== null;
    const gone = {};
    for (const d of c.members) gone[d] = await awaitAskGone(seats.seat[d].cx, c.user[spec.joiner], 120_000);
    const repeats = baseWithheldRepeats(srvLines('chat-delivery-service', c.startSince), c.group.id);
    return {
      members: [...c.members, spec.joiner],
      detail: { follow: w.follow, base: w.base?.status, asks, gone, repeats },
      // THE OLD PAGE MAY NOT SHOW THE NEW WAITING TEXT: its own words are the old build's, not asserted.
      judge: () => [...admittedOwn({ ...w, waitingText: true, asks, admitted, listed, gone }).slice(1), ...rateLimitedOwn(repeats)],
    };
  },

  /** ADM-6: the OLD member may auto-Add the new joiner; if it does not, W1 does. */
  async 'ADM-6'(c) {
    const w = await followAndWait(c);
    const u = c.user[spec.joiner];
    let addedBy = null;
    const shim = await seatReaches(c, u, 'admitted', spec.shimWaitMs);
    if (shim.state === 'admitted' && shim.active > 0) addedBy = `${spec.old} (the shim)`;
    else {
      await awaitAsk(seats.seat[spec.answer.by].cx, u, 90_000);
      await answerAsk(seats.seat[spec.answer.by].cx, u, spec.answer.choice);
      addedBy = spec.answer.by;
    }
    const admitted = await seatReaches(c, u, 'admitted', 60_000);
    const listed = (await awaitListed(seats.seat[spec.joiner].cx, c.group.name, 90_000)) !== null;
    const admissionErrors = srvLines('chat-delivery-service', c.startSince).filter((l) => l.includes('[ADMISSION]') && /\bERROR\b/.test(l) && l.includes(c.group.id)).length;
    return {
      members: [...c.members, spec.joiner],
      detail: { follow: w.follow, base: w.base?.status, addedBy },
      judge: () => oldMemberOwn({ admitted, listed, admissionErrors, addedBy }),
    };
  },

  /** ADM-7: the OLD outsider asks the base; nothing reports an entry nobody made. */
  async 'ADM-7'(c) {
    const O = seats.seat[spec.outsider];
    const base = await baseAs(O, c.group.id);
    await sleep(10_000);
    const uninvited = srvLines('chat-delivery-service', c.startSince).filter((l) => l.includes('[UNINVITED_ENTRY]') && l.includes(c.group.id)).length;
    let notices = 0;
    for (const d of c.members) {
      await openGroup(seats.seat[d].cx, c.group.name, { label: id });
      // `chat_system_uninvited_entry`, the notice a member is shown for an entry nobody made.
      notices += Number(await evaluate(seats.seat[d].cx, `(document.body.innerText.match(/sans qu'un membre ne l'ajoute/g) || []).length`));
    }
    const after = seatState(serverView(c.group.id), c.user[spec.outsider]);
    return {
      members: c.members,
      detail: { base: { status: base.status, threw: base.threw } },
      judge: () => outsiderOwn({ base, uninvited, notices, after }),
    };
  },

  /** ADM-8: a link minted on a 1:1 and on a key group, through the API; no ask may follow. */
  async 'ADM-8'(c) {
    const W1 = seats.seat.W1.cx;
    const J = seats.seat[spec.joiner].cx;
    // INTERPOLATED INTO SQL, so each id is proven a user id first: the 64-hex digest the server keys
    // an account by, or the older uuid ({@link USER_ID}).
    const lower = (u) => {
      if (!USER_ID.test(String(u))) throw new Error(`ADM-8: '${u}' is not a user id`);
      return String(u).toLowerCase();
    };
    const groupOf = {
      direct: psql(
        `SELECT g.id FROM dm_groups g WHERE NOT g."isGroup" AND g."distributionWorkspaceId" IS NULL AND g."distributionChannelId" IS NULL ` +
          `AND EXISTS (SELECT 1 FROM dm_group_members m WHERE m."groupId" = g.id AND lower(m."userId") = '${lower(c.user.W1)}') ` +
          `AND EXISTS (SELECT 1 FROM dm_group_members m WHERE m."groupId" = g.id AND lower(m."userId") = '${lower(c.user.W2)}') LIMIT 1`
      ).trim(),
      'key-group': psql(
        `SELECT g.id FROM dm_groups g JOIN dm_device_group_memberships d ON d."groupId" = g.id ` +
          `WHERE (g."distributionWorkspaceId" IS NOT NULL OR g."distributionChannelId" IS NOT NULL) AND lower(d."userId") = '${lower(c.user.W1)}' AND d.status = 'active' LIMIT 1`
      ).trim(),
    };
    const kinds = [];
    for (const kind of spec.kinds) {
      const gid = groupOf[kind];
      if (!UUID.test(gid)) {
        kinds.push({ kind, missing: `no ${kind} conversation of W1's on this estate to mint on (the fixtures owe one)` });
        continue;
      }
      const mint = await apiPost(W1, `/api/mls/groups/${gid}/invites`, {});
      let token = null;
      try {
        token = JSON.parse(mint.body ?? 'null')?.token ?? null;
      } catch {
        token = null;
      }
      const accept = token ? await apiPost(J, `/api/mls/group-invites/${token}/accept`, {}) : null;
      await sleep(15_000);
      const askLines = askLinesOn(W1, gid) + askLinesOn(seats.seat.W2.cx, gid);
      kinds.push({ kind, mint: { status: mint.status }, accept: accept ? { status: accept.status } : null, tokenLength: token ? token.length : null, askLines, after: seatState(serverView(gid), c.user[spec.joiner]) });
    }
    // THE MINTS ARE REFUSED BY DESIGN - 400 on a 1:1, 403 on a key group - and that refusal is the row.
    expectRefusal('W1', { path: /^\/api\/mls\/groups\/[0-9a-f-]+\/invites$/, status: [400, 403] });
    return { members: c.members, detail: { kinds }, judge: () => noAskOwn(kinds) };
  },
};

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const name = (d) => displayNameOf(user[d]);
  const owner = spec.owner;
  const premise = [];
  const pre = [];
  if (spec.old) {
    const build = await clientBuild(cx(spec.old)).catch(() => null);
    pre.push(...oldBuildOwn({ device: spec.old, build, oldCommit: oldCommit() }));
    if (!pre.every((a) => a.ok)) return { premise: [`${spec.old} is not on the ${OLD_REF} build: ${pre[0].what}`], detail: { build } };
  }
  const group = await mintRowGroup(cx(owner), id, user[owner]);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx(owner), group.name, { navigate: false, label: id });
  if (spec.setup.length) {
    await addMembers(cx(owner), spec.setup.map(name));
    await closeOverlays(cx(owner));
  }
  const members = [owner, ...spec.setup, ...(spec.ownerDevices ?? [])];
  for (const d of members.filter((d) => d !== owner)) if ((await awaitListed(cx(d), group.name, 90_000)) === null) premise.push(`${d} never listed ${group.name}`);
  if (premise.length) return { premise, detail: { group: group.id } };
  // THE ASK SHOWS ON THE CONVERSATION'S OWN ROW: every member has it open.
  for (const d of members) await openGroup(cx(d), group.name, { navigate: false, label: id });

  let link = null;
  if (spec.joiner && id !== 'ADM-8') {
    link = await mintGroupLink(cx(owner), group.name);
    await closeOverlays(cx(owner));
  }
  const fromEpoch = serverView(group.id).activeEpoch;
  const startSince = now();
  const c = { user, group, owner, members, link, startSince };
  const act = await ACTIONS[id](c);
  if (act.premise?.length) return { premise: act.premise, detail: { group: group.id, ...act.detail } };

  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members: act.members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  return {
    own: [...pre, ...act.judge()],
    invariant,
    records: act.records ?? {},
    unjudged: act.unjudged ?? [],
    detail: { group: group.id, name: group.name, fromEpoch, linkLength: link ? link.length : null, ...act.detail, ...(spec.note ? { note: spec.note } : {}) },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [], unjudged: out.unjudged ?? [] });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  // THE ASK IS EVERY MEMBER'S SUBJECT AND THE WAIT IS THE JOINER'S: each device is given the
  // narration of its own part, about this row's group and the endings this row plays
  // (`ADMISSION_ENDINGS`) - and a row that raises no ask (ADM-7, ADM-8) is given none.
  const logs = {};
  const ends = ADMISSION_ENDINGS[id];
  const group = out.detail?.group;
  for (const d of spec.devices) {
    logs[d] = !ends || !group ? [] : d === spec.joiner ? admissionJoinerNarration(group, ends) : admissionMemberNarration(group, ends);
    if (d === spec.owner) logs[d].push(...GROUP_CREATION_NARRATION);
  }
  const observers = await observersOf(seats, { logs, refusals: rowRefusals, provoked: out.records ?? {} });
  await finishObserved(
    id,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    () => closeSeats(seats)
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  record(id, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}
