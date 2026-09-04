/**
 * COMM-5: a promotion, twice, and the capability that is supposed to arrive with it.
 *
 *   bun comm5.mjs
 *
 * THE ROW ASKS TWO THINGS AND THEY FAIL DIFFERENTLY. That the role CHANGES is a question for the
 * server: `channel_members.roleIds` names a different `channel_roles` row afterwards, or it does
 * not. That the grid TAKES EFFECT is a question for the other device: the person promoted has to
 * gain what the role grants, and gaining it a minute later after a reload is a different answer from
 * gaining it at once - not a worse one necessarily, but not the same one.
 *
 * SO BOTH ARE MEASURED, and the first run measured them before deciding what to fail on. That run
 * (2026-08-20) recorded `liveWithoutReload: false`: the change reached the other device NEVER, and
 * the direction that mattered was the demotion - an administrator went on being offered every
 * control they had just lost until they reloaded. The user's decision was to PUSH the change to the
 * member it concerns, so `workspace.role.changed` now exists and the expectation is STRICT.
 *
 * The reload path stays in the check, and is not dead weight: `capabilityAfterReload` separates
 * "the push did not arrive" from "the grant never happened at all", and those are two different
 * bugs with two different owners.
 *
 * THE CAPABILITY IS READ AS A SHAPE, NOT AS A LABEL. The members tab renders a `<select>` per member
 * to somebody who may manage the community and a translated badge to everybody else, so
 * `communityMembers().readFrom` IS the permission, observed rather than described. A check that
 * looked for the word "Administrateur" would be asserting on `fr.json` and would pass for a client
 * that merely SEES the role without holding it.
 *
 * IT PUTS THE VENUE BACK. The peer is returned to `member` at the end and the restoration is
 * asserted like everything else: a check that leaves the campaign's second account an administrator
 * has changed what every later row runs against, silently.
 */
import { client, goto } from '../chat.mjs';
import {
  communityMembers,
  enterCommunities,
  openCommunity,
  openCommunityMembers,
  setMemberRole,
} from '../comm.mjs';
import { communityRole, userIdOf, workspaceIdOf } from '../grainedb.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from '../names.mjs';
import { mark, record } from '../results.mjs';
import { consoleLines, gate, report, watch } from '../watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

mark('COMM5');

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const workspaceId = await step('read the community id', () => workspaceIdOf(VENUE.community));
const peerUserId = await step('read the peer id', () => userIdOf(PEER_NAME));

/** The role the SERVER holds for the peer - the only witness that a promotion took effect. */
const serverRole = () => (workspaceId && peerUserId ? communityRole(workspaceId, peerUserId) : null);

/**
 * Whether the peer's own client renders the manage controls, waited for rather than sampled.
 *
 * A ROLE ARRIVING IS AN EVENT ON ANOTHER DEVICE, so reading once and concluding measures the
 * harness. The wait is bounded and the bound is reported: "it was not there after 20 s" is a
 * statement a reader can argue with, "it was not there" is not.
 */
const peerCanManage = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await communityMembers(w2).catch(() => []);
    if (seen.some((m) => m.readFrom === 'select')) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
};

// -- The starting state, which is the arming ----------------------------------
await step('open the community on the owner', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, VENUE.community);
  await openCommunityMembers(w1);
});

await step('open the community on the peer', async () => {
  await enterCommunities(w2);
  await openCommunity(w2, VENUE.community);
  await openCommunityMembers(w2);
});

const roleBefore = serverRole();
const peerCouldManageBefore = await step('read the peer capability before', () =>
  communityMembers(w2).then((seen) => seen.some((m) => m.readFrom === 'select'))
);

// A peer who is ALREADY an administrator arms nothing: every assertion below would be about a
// promotion that changed no state. Recorded as VACUOUS rather than passed.
const armed = roleBefore === 'member' && peerCouldManageBefore === false;

// -- Promotion, one step at a time --------------------------------------------
const toModerator = armed
  ? await step('promote to moderator', () => setMemberRole(w1, PEER_NAME, 'moderator'))
  : null;
const roleAfterModerator = armed ? serverRole() : null;

const toAdmin = armed
  ? await step('promote to admin', () => setMemberRole(w1, PEER_NAME, 'admin'))
  : null;
const roleAfterAdmin = armed ? serverRole() : null;

// -- Does it reach the other device, and when ---------------------------------
const liveWithoutReload = armed ? await peerCanManage(20000) : null;
const afterReload = liveWithoutReload
  ? true
  : armed
    ? await step('reload the peer and look again', async () => {
        // `goto`, NOT `Page.reload`. A raw reload cancels whatever the page had in flight, and the
        // first run of this check recorded its own `GET /communities -> net::ERR_ABORTED` as dirt
        // on the application. A check must not manufacture the noise it then reports.
        await goto(w2, '/communities', { relaunch: 'the role has to be re-fetched from scratch' });
        await enterCommunities(w2);
        await openCommunity(w2, VENUE.community);
        await openCommunityMembers(w2);
        return peerCanManage(20000);
      })
    : null;

// -- Put the venue back -------------------------------------------------------
const restored = armed
  ? await step('demote back to member', () => setMemberRole(w1, PEER_NAME, 'member'))
  : null;
const roleAtEnd = armed ? serverRole() : null;

const expectations = {
  // The server's half: each step landed, and landed as the step asked.
  moderatorTookEffect: roleAfterModerator === 'moderator',
  adminTookEffect: roleAfterAdmin === 'admin',
  // The other device's half, and it is strict since the push shipped: the capability must arrive
  // WITHOUT a reload. `capabilityReached` stays beside it so a failure says which of the two broke.
  capabilityIsLive: liveWithoutReload === true,
  capabilityReached: afterReload === true,
  // And the venue is as it was found.
  venueRestored: roleAtEnd === 'member',
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const raw = [
  ['W1', consoleLines(wa.cx)],
  ['W2', consoleLines(wb.cx)],
];
const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-5', gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  owner: OWNER_NAME,
  peer: peerUserId ? peerUserId.slice(0, 8) : null,
  armed: { roleBefore, peerCouldManageBefore },
  serverRoles: { afterModerator: roleAfterModerator, afterAdmin: roleAfterAdmin, atEnd: roleAtEnd },
  panelAfterModerator: toModerator?.after ?? null,
  panelAfterAdmin: toAdmin?.after ?? null,
  panelAfterDemotion: restored?.after ?? null,
  // THE ROW'S WORD "IMMEDIATELY", MEASURED SEPARATELY FROM THE ROW'S PASS. False here with
  // `capabilityReached` true means the grant is real but needs a reload - a finding for the app or
  // for the row, and one this file deliberately does not settle by itself.
  liveWithoutReload,
  capabilityAfterReload: afterReload,
  ...expectations,
  failures,
});

for (const [label, lines] of raw) {
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

w1.close();
w2.close();
