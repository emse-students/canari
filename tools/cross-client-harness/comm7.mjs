/**
 * COMM-7: a salon only administrators may write in - and the refusal has to be the SERVER's.
 *
 *   node comm7.mjs
 *
 * WHY A UI ASSERTION IS NOT ENOUGH, AND WHY A SERVER ASSERTION ALONE IS NOT EITHER. A composer that
 * is hidden proves nothing about what the server accepts: the rule is enforced in
 * `canWriteToChannel`, and a client that simply does not offer the control is one modified client
 * away from posting. A 403 with the composer still on screen is the other half of the same defect -
 * the product offering an action it will always refuse, which the person doing it reads as the app
 * being broken rather than as a rule. So both are asserted, separately, and a failure says which.
 *
 * THE PROBE IS THE SAME REQUEST TWICE, REFUSED FOR TWO DIFFERENT REASONS, and that is what makes it
 * evidence. `sendMessage` checks membership, then access, then `writePolicy`, and only THEN that the
 * body names a Graine session. A deliberately session-less body therefore reaches the write check
 * first: under `everyone` it comes back **400 CHANNEL_SESSION_REQUIRED**, and under `admins` the
 * same body comes back **403**. The 400 is the positive control - without it, a 403 could equally
 * mean the probe was malformed, the account was not a member, or the salon was private, and the
 * check would be reporting the write policy while measuring something else entirely.
 *
 * IT NEVER WRITES ANYTHING. The probe cannot store a message even when it is allowed to - the body
 * is missing the two fields a readable message needs - so nothing this check does leaves a row in
 * the salon it then deletes.
 *
 * THE ADMINISTRATOR IS THE OTHER CONTROL. A rule that refuses everybody is not this rule, and it
 * would pass every assertion about the member. W1 posts after the flip and W2 must see it.
 *
 * IT BUILDS ITS OWN VENUE and deletes it: the shared community must not collect a salon nobody may
 * write in.
 */
import {
  apiPost,
  awaitMessage,
  client,
  countMessage,
  evaluate,
  realClick,
  send,
} from './chat.mjs';
import {
  acceptInviteLink,
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  inviteLink,
  openChannelAccess,
  openCommunity,
  openInviteLink,
  saveChannelAccess,
  selectedChannel,
  setChannelWritePolicy,
} from './comm.mjs';
import { channelIdOf, channelWritePolicy, workspaceIdOf } from './grainedb.mjs';
import { PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, ignoringExpectedRefusal, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const run = mark('COMM7');
const community = `C7 ${run}`;
const salon = `c7-${run.toLowerCase()}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The body that reaches the write check and can never reach the database. */
const PROBE = { ciphertext: 'comm7-probe', nonce: 'comm7-probe' };

/**
 * Whether this client is currently OFFERING a composer the person could type in.
 *
 * Read as three separate facts rather than one boolean, because "there is no composer" and "there
 * is a composer nobody may use" are different products and only one of them is the fix. A salon
 * that refuses writing should show the second thing at most, and ideally say why.
 */
async function composerState(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify((function () {
         var el = document.querySelector('.chat-composer-footer .chat-composer-editor');
         if (!el) return { present: false, editable: false, ariaDisabled: null };
         return {
           present: true,
           editable: el.isContentEditable === true && el.getAttribute('aria-disabled') !== 'true',
           ariaDisabled: el.getAttribute('aria-disabled'),
         };
       })())`
    )
  );
}

/** Opens the salon on a client that is already inside the community. */
async function openSalon(cx) {
  await realClick(cx, `[aria-label*=${JSON.stringify(salon)}]`);
  const open = await selectedChannel(cx);
  if (open !== salon) throw new Error(`wrong salon open: ${JSON.stringify(open)}`);
}

// -- A community with two people in it, and a public salon -----------------------------
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

// PUBLIC on purpose: a private salon would add an allowlist to every refusal below, and this row is
// about who may WRITE, not about who may see.
await step('create the salon', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon, { visibility: 'public' });
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// -- Arming: under the default, the member can write and the probe says so -------------
await step('open the salon on both clients', async () => {
  await openSalon(w1);
  await enterCommunities(w2);
  await openCommunity(w2, community);
  await openSalon(w2);
});

const beforeMarker = `${run}-open`;
const memberWroteBefore = await step('the member posts while everyone may', async () => {
  await send(w2, beforeMarker);
  return (await awaitMessage(w1, beforeMarker, 30_000)) ? true : false;
});

// THE POSITIVE CONTROL, and it is taken BEFORE the flip so it describes the same salon in its
// permissive state. A 400 here means the probe reaches the body check, i.e. it got past membership,
// access and the write policy - which is exactly what the 403 later must be attributed to.
const probeBefore = await step('probe the write check while everyone may', async () => {
  if (!channelId) throw new Error('no salon id to probe');
  return apiPost(w2, `/api/channels/${channelId}/messages`, PROBE);
});

// -- The flip --------------------------------------------------------------------------
await step('restrict writing to administrators', async () => {
  await openSalon(w1);
  await openChannelAccess(w1);
  await setChannelWritePolicy(w1, 'admins');
  await saveChannelAccess(w1);
});
const storedPolicy = channelId ? channelWritePolicy(channelId) : null;

// Nothing below means anything unless the salon really is restricted and the member really could
// write a moment ago.
const armed =
  !!workspaceId && !!channelId && memberWroteBefore === true && storedPolicy === 'admins';

// -- What the member is shown, and what the server does --------------------------------
//
// READ FIRST, ACT SECOND. Whether the product still offers the composer is a fact about the screen
// as the rule lands; typing into it would be measuring the screen after the check had used it.
const composerAfter = armed ? await step('read the member composer', () => composerState(w2)) : null;

const probeAfter = armed
  ? await step('probe the write check as the member', () =>
      apiPost(w2, `/api/channels/${channelId}/messages`, PROBE)
    )
  : null;

// THE END-TO-END HALF: whatever the screen offered, nothing the member sends may land. Attempted
// only when a composer was actually offered - a check may not manufacture a gesture the product
// does not have.
const afterMarker = `${run}-blocked`;
const memberSendLanded =
  armed && composerAfter?.editable
    ? await step('the member tries anyway', async () => {
        await send(w2, afterMarker).catch(() => null);
        await new Promise((r) => setTimeout(r, 8000));
        return (await countMessage(w1, afterMarker)) > 0;
      })
    : null;

// -- The administrator is not affected --------------------------------------------------
const adminMarker = `${run}-admin`;
const adminWrote = armed
  ? await step('the administrator posts', async () => {
      await openSalon(w1);
      await send(w1, adminMarker);
      return (await awaitMessage(w2, adminMarker, 30_000)) ? true : false;
    })
  : null;

// -- Its own debris goes ------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  // The control: the same probe, the same salon, refused for the body rather than for the rule.
  probeReachedTheWriteCheck: probeBefore?.status === 400,
  // THE SERVER'S HALF, which is the one that is actually a guarantee.
  serverRefusedTheMember: probeAfter?.status === 403,
  // THE UI'S HALF. Not "the composer is gone" - a salon may well explain itself instead - but the
  // person must not be handed a control whose every use the server will refuse.
  uiDidNotOfferAWriteItWillRefuse: composerAfter?.editable === false,
  // Whatever the screen did, nothing may land.
  nothingTheMemberSentLanded: memberSendLanded !== true,
  // The rule is a rule about ADMINISTRATORS, not a salon nobody may write in.
  theAdministratorCanStillWrite: adminWrote === true,
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const linesW1 = consoleLines(wa.cx);
const linesW2 = consoleLines(wb.cx);
// THE REFUSALS ARE THE MEASUREMENT, and only these. Narrow to this salon's message route and to the
// two statuses this check deliberately provokes, so a 403 from anywhere else still breaks `clean`.
const gated = gate(verdict, {
  W1: await report(wa),
  W2: ignoringExpectedRefusal(await report(wb), [
    { path: new RegExp(`/api/channels/${channelId}/messages$`), status: [400, 403] },
  ]),
});

record('COMM-7', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  armed,
  memberWroteBefore,
  storedPolicy,
  probeBefore,
  probeAfter,
  composerAfter,
  memberSendLanded,
  adminWrote,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${linesW1.length} console lines =====`);
for (const l of linesW1) console.log(`  ${l}`);
console.log(`\n===== W2: ${linesW2.length} console lines =====`);
for (const l of linesW2) console.log(`  ${l}`);

w1.close();
w2.close();
