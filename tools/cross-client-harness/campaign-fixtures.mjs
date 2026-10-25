/**
 * THE CAMPAIGN'S FIXTURES ON THE ESTATE `SITE` NAMES, BUILT THROUGH THE PRODUCT AND RECORDED AS OWNED.
 *
 *   bun campaign-fixtures.mjs            # READ ONLY: what exists, what is owed; touches nothing
 *   bun campaign-fixtures.mjs --build    # build what is owed, through the screens, and record it
 *
 * R5 of the 1.4.1 campaign (`docs/wiki/cross-client-campaign-1-4-1.md`, sections 3 and 5 step 2):
 * the four rig accounts signed in, the owner-peer DM, the venue with a public and a private salon,
 * and the groups `campaign-g2`, `campaign-g4`, `campaign-big` (`CAMPAIGN_FIXTURES`). Run AFTER R7 -
 * the pre-release the campaign measures - is on dev, so the fixtures are built by the build under
 * test.
 *
 * THROUGH THE PRODUCT, NEVER THE DATABASE, for the reason `venue.mjs` gives: a community or a group
 * inserted as rows has no key-distribution group and no MLS tree, and every row standing on it would
 * measure a state no gesture can produce. The database is READ - to decide what is owed and to learn
 * the ids - and never written.
 *
 * EVERYTHING IT BUILDS IS RECORDED in the campaign ledger (`campaign.mjs`) WITH ITS ID, which is what
 * lets a later destructive row touch it on dev and nothing else. The four accounts and each seat's
 * device are recorded too: `purge-devices.mjs` on dev may purge only a recorded device.
 *
 * WHO SITS WHERE is `names.mjs`: each account must own a web seat in `ACCOUNT_OF` with a port in
 * `PORTS` (the plan puts third and fourth on W4/W5). A missing seat is a refusal naming the line to add.
 * No admin right is needed: the owner creates the venue, so it administers it.
 *
 * IT IS IDEMPOTENT (`fixturesOwed`): a second run over a built estate owes nothing and opens no client.
 */
import { spawnSync } from 'node:child_process';
import { accountFor, subjectFor } from './accounts.mjs';
import { addMembers } from './archive/addmember.mjs';
import { CAMPAIGN_FIXTURES, fixturesOwed } from './campaign-ledger.mjs';
import { ESTATE, ledger, recordCreated } from './campaign.mjs';
import { APP_TAB, client, evaluate } from './chat.mjs';
import { createChannel, enterCommunities, inviteToCommunity, openCommunity } from './comm.mjs';
import { psql } from './estate.mjs';
import {
  awaitCommunityRouting,
  channelIdOf,
  communityMemberIds,
  directConversation,
  workspaceIdOf,
} from './grainedb.mjs';
import { closeOverlays, createDM, createGroup, openGroup } from './groupnav.mjs';
import { ACCOUNT_OF, PORTS, VENUE } from './names.mjs';
import { requireScript, HARNESS_ROOT } from './scriptpath.mjs';
import { SITE } from './site.mjs';

const build = process.argv.includes('--build');
const SPEC = CAMPAIGN_FIXTURES;
const rows = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|'));

// ── seats ────────────────────────────────────────────────────────────────────────────────────
/** account key -> its web seat (W*) and port, from `names.mjs`. */
const seats = {};
for (const key of SPEC.accounts) {
  const device = Object.keys(ACCOUNT_OF).find((d) => ACCOUNT_OF[d] === key && /^W\d+$/.test(d) && PORTS[d]);
  if (device) seats[key] = { device, port: PORTS[device] };
}
const unseated = SPEC.accounts.filter((k) => !seats[k]);
if (unseated.length) {
  console.log(
    `[fixtures] REFUSING - no web seat for ${unseated.join(', ')}: add e.g. ACCOUNT_OF.W4 = "third" and ` +
      `PORTS.W4 = <its CDP port> to the machine-local names.mjs (plan section 4.1)`
  );
  process.exit(1);
}
for (const k of SPEC.accounts) accountFor(k); // a missing account in test-accounts.json throws, named

// ── observe ──────────────────────────────────────────────────────────────────────────────────
const sub = Object.fromEntries(SPEC.accounts.map((k) => [k, subjectFor(k)]));
const keyOfUser = Object.fromEntries(Object.entries(sub).map(([k, s]) => [s.toLowerCase(), k]));
const displayName = (key) => rows(psql(`SELECT "displayName" FROM users WHERE id = '${sub[key]}'`))[0]?.[0] ?? null;

/** The live group `name` the OWNER is a member of, or null; ambiguity is a refusal. */
function groupOf(name) {
  const found = rows(
    psql(
      `SELECT g.id FROM dm_groups g WHERE g.name = '${name.replace(/'/g, "''")}' AND g."deletedAt" IS NULL ` +
        `AND EXISTS (SELECT 1 FROM dm_group_members m WHERE m."groupId" = g.id AND m."userId" = '${sub.owner}')`
    )
  );
  if (found.length > 1) throw new Error(`[fixtures] ${found.length} live groups named ${name} hold the owner - resolve by hand`);
  return found[0]?.[0] ?? null;
}
const membersOf = (groupId) =>
  rows(psql(`SELECT "userId" FROM dm_group_members WHERE "groupId" = '${groupId}'`))
    .map(([u]) => keyOfUser[u.toLowerCase()])
    .filter(Boolean);

function observe() {
  const accounts = Object.fromEntries(SPEC.accounts.map((k) => [k, displayName(k) !== null]));
  const dm = accounts.owner && accounts.peer ? directConversation(sub.owner, sub.peer) : null;
  const workspaceId = accounts.owner ? workspaceIdOf(VENUE.community, { memberUserId: sub.owner }) : null;
  const publicId = workspaceId ? channelIdOf(workspaceId, VENUE.channel) : null;
  const privateId = workspaceId ? channelIdOf(workspaceId, SPEC.privateSalon) : null;
  const groupIds = Object.fromEntries(SPEC.groups.map((g) => [g.name, accounts.owner ? groupOf(g.name) : null]));
  return {
    seen: {
      accounts,
      dm: !!dm,
      venue: {
        community: !!workspaceId,
        publicSalon: !!publicId,
        privateSalon: !!privateId,
        members: workspaceId
          ? communityMemberIds(workspaceId).map((u) => keyOfUser[u.toLowerCase()]).filter(Boolean)
          : [],
      },
      groups: Object.fromEntries(Object.entries(groupIds).map(([n, id]) => [n, id ? membersOf(id) : null])),
    },
    ids: { dm: dm?.groupId ?? null, workspaceId, publicId, privateId, groupIds },
  };
}

console.log(`[fixtures] estate ${ESTATE} (${SITE}); seats ${SPEC.accounts.map((k) => `${k}=${seats[k].device}`).join(' ')}`);
let { seen, ids } = observe();
let owed = fixturesOwed(seen);
console.log(owed.length ? `[fixtures] owed: ${owed.join(', ')}` : '[fixtures] nothing owed - every fixture exists');

/** Record what exists, with its id, unless the ledger already holds that id. Safe to repeat. */
function recordExisting() {
  const held = new Set(ledger().map((e) => `${e.kind}:${e.id}`));
  const add = (t) => {
    if (t.id && !held.has(`${t.kind}:${t.id}`)) recordCreated({ ...t, by: 'campaign-fixtures' });
  };
  for (const k of SPEC.accounts) if (seen.accounts[k]) add({ kind: 'account', id: sub[k], name: k });
  if (ids.dm) add({ kind: 'dm', id: ids.dm, name: SPEC.dm.join('-') });
  if (ids.workspaceId) add({ kind: 'community', id: ids.workspaceId, name: VENUE.community });
  if (ids.publicId) add({ kind: 'salon', id: ids.publicId, name: VENUE.channel, parent: VENUE.community });
  if (ids.privateId) add({ kind: 'salon', id: ids.privateId, name: SPEC.privateSalon, parent: VENUE.community });
  for (const [name, id] of Object.entries(ids.groupIds)) if (id) add({ kind: 'group', id, name });
}

if (!build) {
  console.log('[fixtures] read only - pass --build to build what is owed (after R7, plan section 5 step 2)');
  process.exit(0);
}

// ── build ────────────────────────────────────────────────────────────────────────────────────
/** A harness script, run as the rig runs them: same runtime, harness root as cwd, output shown. */
function run(file, args) {
  const r = spawnSync(process.execPath, [requireScript(file), ...args], { cwd: HARNESS_ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`[fixtures] ${file} ${args.join(' ')} exited ${r.status}`);
}

/** The device id this seat's page holds for its account (`mls_device_id_<sub>`), or null. */
async function seatDevice(key) {
  const cx = await client(seats[key].port, APP_TAB, { focus: false });
  try {
    const id = await evaluate(cx, `localStorage.getItem(${JSON.stringify(`mls_device_id_${sub[key]}`)}) || ''`);
    return id || null;
  } finally {
    cx.close();
  }
}

// 1. THE ACCOUNTS: a first sign-in creates the user row (`findOrCreateFromOidc`); the PIN enrols the device.
for (const k of SPEC.accounts) {
  if (seen.accounts[k]) continue;
  const { port } = seats[k];
  run('login.mjs', ['--port', String(port), '--account', k]);
  run('pin.mjs', ['--port', String(port), '--account', k]);
}
for (const k of SPEC.accounts) {
  const device = await seatDevice(k);
  if (device && !ledger().some((e) => e.kind === 'device' && e.id === device)) {
    recordCreated({ kind: 'device', id: device, name: `${seats[k].device}:${k}`, by: 'campaign-fixtures' });
  }
}
({ seen, ids } = observe());
const notIn = SPEC.accounts.filter((k) => !seen.accounts[k]);
if (notIn.length) throw new Error(`[fixtures] still no user row for ${notIn.join(', ')} after signing in - stop here`);
const name = Object.fromEntries(SPEC.accounts.map((k) => [k, displayName(k)]));

const owner = await client(seats.owner.port, APP_TAB, { focus: false });
try {
  // 2. THE DM, from the owner, by the peer's display name (idempotent: `createDM` reads the sidebar).
  if (!seen.dm) await createDM(owner, name.peer, { label: 'campaign-fixtures' });

  // 3. THE VENUE: `venue.mjs` owns the community, its public salon and the peer's seat in it.
  if (!seen.venue.community || !seen.venue.publicSalon) run('venue.mjs', []);
  ({ seen, ids } = observe());
  if (!seen.venue.privateSalon) {
    await enterCommunities(owner);
    await openCommunity(owner, VENUE.community);
    await createChannel(owner, SPEC.privateSalon, { visibility: 'private' });
  }

  // 3b. EVERY ACCOUNT IN THE VENUE (`venueMembers`): the owner invites by display name, then the
  // member's own seat LOADS the community, because a member's device joins the delivery roster only
  // when it loads it (`venue.mjs` says why) - a seat in `channel_members` alone carries no frame.
  ({ seen, ids } = observe());
  for (const k of SPEC.venueMembers.filter((m) => !seen.venue.members.includes(m))) {
    await enterCommunities(owner);
    await openCommunity(owner, VENUE.community);
    await inviteToCommunity(owner, name[k], 'member');
    const seat = await client(seats[k].port, APP_TAB, { focus: false });
    try {
      await enterCommunities(seat);
      await openCommunity(seat, VENUE.community);
    } finally {
      seat.close();
    }
    const routed = await awaitCommunityRouting(ids.workspaceId, sub[k], true, 60_000);
    if (!routed.ok) throw new Error(`[fixtures] ${k} is in the venue but its device never joined the delivery roster`);
    console.log(`[fixtures] ${k} joined the venue, routed after ${routed.elapsedMs}ms`);
  }

  // 4. THE GROUPS, created by the owner, then every missing member added in ONE bulk Add - one
  // commit, the product's ordinary path (`addMembers`). One Add per member would give each fixture a
  // history of N single-member commits that no user produces, and every row standing on it would
  // inherit that shape. FLOOR-2 asks the bulk-Add question on a group of its own (`archive/floor.mjs`).
  for (const g of SPEC.groups) {
    if (!seen.groups[g.name]) await createGroup(owner, g.name, { label: 'campaign-fixtures' });
    const held = observe().seen.groups[g.name] ?? [];
    const missing = g.members.filter((m) => !held.includes(m));
    if (!missing.length) continue;
    await closeOverlays(owner);
    await openGroup(owner, g.name, { navigate: false, label: 'campaign-fixtures' });
    await addMembers(owner, missing.map((m) => name[m]));
  }
} finally {
  owner.close();
}

// 5. RECORD EVERY ID, then say what is still owed - a member whose Add is still in flight shows here.
({ seen, ids } = observe());
recordExisting();
owed = fixturesOwed(seen);
console.log(owed.length ? `[fixtures] STILL owed after the build: ${owed.join(', ')}` : '[fixtures] built - nothing owed');
process.exit(owed.length ? 1 : 0);
