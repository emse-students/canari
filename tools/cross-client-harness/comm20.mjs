/**
 * COMM-20: two administrators change the same role at the same moment.
 *
 *   node comm20.mjs
 *
 * WHAT THE PRODUCT ACTUALLY SENDS DECIDES WHAT THIS CAN ASK. A cell in the permission grid does not
 * send "grant this one permission": `setRolePermissions` PUTs the role's WHOLE list, computed from
 * the grid the browser is currently holding. So two administrators toggling two DIFFERENT
 * permissions of one role at the same moment are not merged by anything - the second PUT carries a
 * list built before the first one landed, and overwrites it. That is not a race with an
 * interesting winner; it is a lost update, and it is deterministic.
 *
 * SO THE ASSERTION IS CONVERGENCE, NOT VICTORY. Which of the two edits survives is not a property
 * the product promises and this check does not invent one. What it does demand is that after the
 * dust settles there is exactly ONE answer, that it is one of the two intended states rather than
 * some third thing, and - the part that actually bites - **that both screens agree with the column**.
 * A grid still showing a permission the server dropped is the failure mode COMM-6 named from the
 * other end: a row in a matrix that decides nothing, read by its owner as a control.
 *
 * WHETHER AN EDIT WAS LOST IS RECORDED, NOT ASSERTED, for the same reason - and it is recorded
 * precisely so the decision to add a merge, or an "someone else changed this" refusal, has a
 * measurement rather than an intuition behind it.
 *
 * SIMULTANEITY IS PRODUCED THROUGH THE PRODUCT, not around it. Both clicks are real clicks on two
 * real grids; they are simply issued without waiting for the first one's request to land, which is
 * exactly what two people in two rooms do. Nothing here posts to the API to manufacture a state a
 * user could not reach.
 *
 * IT BUILDS ITS OWN VENUE, promotes the peer to administrator inside it, and deletes it.
 */
import { client, until } from './chat.mjs';
import {
  acceptInviteLink,
  caption,
  communityTab,
  createCommunity,
  cyclePermissionCell,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  openCommunity,
  openInviteLink,
  permissionGrid,
  permissionKeyOf,
  setMemberRole,
} from './comm.mjs';
import { communityRoles, workspaceIdOf } from './grainedb.mjs';
import { PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM20');
const community = `C20 ${run}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/**
 * The two cells, on the MODERATOR's column, and the two permissions behind them.
 *
 * The moderator is chosen for the same reason COMM-6 chose it: the administrator's column is locked
 * and the member's is empty, so a toggle there could only ever grant. One admin REVOKES what the
 * role has (`channel.moderate`) and the other GRANTS what it has not (`role.manage`) - two edits
 * that cannot be confused for one another in the column afterwards.
 */
const MODERATOR_COLUMN = 2;
const W1_TOGGLES = { label: caption('chat_permission_moderate_label'), key: 'channel.moderate' };
const W2_TOGGLES = { label: caption('chat_permission_manage_roles_label'), key: 'role.manage' };

/** Opens the roles grid on a client and waits for the table to have rendered its rows. */
async function openGrid(cx) {
  await communityTab(cx, 'roles');
  await until(cx, `!!document.querySelector('table tbody tr')`, 20000);
  return permissionGrid(cx);
}

/** The moderator role as the SERVER holds it, or null. */
const storedModerator = () =>
  workspaceId ? (communityRoles(workspaceId).find((r) => r.priority === 50) ?? null) : null;

/** Waits for the column to stop changing, and returns what it settled on. */
async function columnSettles(quietMs = 6000, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = JSON.stringify(storedModerator()?.permissions ?? null);
  let quietSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = JSON.stringify(storedModerator()?.permissions ?? null);
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return storedModerator();
    }
    if (Date.now() > deadline) return storedModerator();
  }
}

/**
 * What one client's grid says the moderator column holds, as the LABELS it is showing as allowed.
 *
 * Compared against the column by COUNT and by membership rather than by key, because the grid speaks
 * labels and the database speaks keys - and translating one into the other here would put a third
 * copy of the mapping in the harness. The two lists are the same length and the same set, or the
 * screen and the server disagree, which is the whole question.
 */
async function gridSaysModeratorAllows(cx) {
  const shown = await permissionGrid(cx);
  if (!Array.isArray(shown?.permissions) || !Array.isArray(shown?.cells)) return null;
  return shown.permissions.filter(
    (_label, row) => shown.cells[row]?.[MODERATOR_COLUMN - 1] === 'allow'
  );
}

// -- A community with two administrators in it -------------------------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

await step('put the peer in the community', async () => {
  if (!workspaceId) return;
  const link = await inviteLink(w1);
  const preview = await openInviteLink(w2, link);
  if (preview.valid) await acceptInviteLink(w2);
});

await step('promote the peer to administrator', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await setMemberRole(w1, PEER_NAME, 'admin');
});

const before = await step('read the moderator role', () => storedModerator());

const grids = await step('both administrators open the grid', async () => {
  const mine = await openGrid(w1);
  await enterCommunities(w2);
  await openCommunity(w2, community);
  const theirs = await openGrid(w2);
  return { w1: mine, w2: theirs };
});

// Nothing below means anything unless BOTH clients are really holding an editable grid of the same
// role, and the role really starts from the state the two edits are described against.
const armed =
  !!workspaceId &&
  Array.isArray(grids?.w1?.permissions) &&
  Array.isArray(grids?.w2?.permissions) &&
  !!before &&
  before.permissions.includes(W1_TOGGLES.key) &&
  !before.permissions.includes(W2_TOGGLES.key);

// -- The two edits, issued without waiting for each other ---------------------------------
const clicked = armed
  ? await step('both toggle at once', async () => {
      // NOT AWAITED IN TURN. Awaiting the first click's request would make this a sequence, which is
      // the case that already works and is not what the row is about.
      const both = await Promise.allSettled([
        cyclePermissionCell(w1, W1_TOGGLES.label, MODERATOR_COLUMN),
        cyclePermissionCell(w2, W2_TOGGLES.label, MODERATOR_COLUMN),
      ]);
      return both.map((r) => r.status);
    })
  : null;

const settled = armed ? await step('what the column settled on', () => columnSettles()) : null;

// READ AFTER THE COLUMN IS QUIET, so a screen is never compared against a server still deciding.
const screens = armed
  ? await step('what each grid says afterwards', async () => ({
      w1: await gridSaysModeratorAllows(w1),
      w2: await gridSaysModeratorAllows(w2),
    }))
  : null;

// -- Its own debris goes ------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const has = (key) => (settled?.permissions ?? []).includes(key);
/** The two states either edit alone would have produced. */
const OUTCOME_W1_WON = !has(W1_TOGGLES.key) && !has(W2_TOGGLES.key);
const OUTCOME_W2_WON = has(W1_TOGGLES.key) && has(W2_TOGGLES.key);
const OUTCOME_BOTH_APPLIED = !has(W1_TOGGLES.key) && has(W2_TOGGLES.key);

/**
 * Whether a grid's own idea of the moderator's permissions matches the column, as SETS OF KEYS.
 *
 * Translated through `PERMISSION_LABELS`, which is the harness's single copy of that mapping - a
 * comparison by count alone would pass a grid that had swapped one permission for another.
 */
const agrees = (shown) => {
  if (!Array.isArray(shown) || !Array.isArray(settled?.permissions)) return false;
  const asKeys = shown.map(permissionKeyOf).filter(Boolean);
  const stored = settled.permissions;
  return (
    asKeys.length === shown.length &&
    asKeys.length === stored.length &&
    asKeys.every((k) => stored.includes(k))
  );
};

const expectations = {
  // Both clicks were accepted by their own grid - a cell that refused the click is not a race.
  bothGridsTookTheClick: clicked?.every((s) => s === 'fulfilled') === true,
  // ONE ANSWER, and it is one of the states an edit was actually asking for. A fourth state - the
  // role losing a permission neither administrator touched - is the corruption worth naming.
  theColumnHoldsOneCoherentState: OUTCOME_W1_WON || OUTCOME_W2_WON || OUTCOME_BOTH_APPLIED,
  theRoleKeptWhatNobodyTouched:
    (settled?.permissions ?? []).includes('member.invite') &&
    (settled?.permissions ?? []).includes('member.kick'),
  // THE PART THAT BITES: a grid that goes on showing a permission the server dropped is a control
  // that decides nothing, and its owner has no way to know.
  theFirstAdminsGridAgreesWithTheServer: agrees(screens?.w1),
  theSecondAdminsGridAgreesWithTheServer: agrees(screens?.w2),
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-20', gated.verdict, {
  ...gated.detail,
  community,
  workspaceId,
  armed,
  before,
  clicked,
  settled,
  screens,
  // RECORDED, NOT ASSERTED. Which edit survived, and whether one was lost - the figure the decision
  // to merge, or to refuse a stale write, has to be made against.
  outcome: OUTCOME_BOTH_APPLIED
    ? 'both edits applied'
    : OUTCOME_W1_WON
      ? 'the first edit won, the second was lost'
      : OUTCOME_W2_WON
        ? 'the second edit won, the first was lost'
        : 'neither - the column holds a state no edit asked for',
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
