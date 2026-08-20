/**
 * COMM-25: one account's SECOND device is carried into a private salon by the first one's join.
 *
 *   node comm25.mjs
 *
 * A SALON'S GROUP IS A ROSTER OF DEVICES, NOT OF PEOPLE. MLS gives every device its own leaf, so
 * "this account may read the salon" has to become one membership per device that account holds, and
 * nothing in the product asks the second device to do anything: the person granted access acted
 * once, on one device, and the other one was not in the room. If the fan-out is per-USER somewhere
 * it should be per-DEVICE, the phone in their pocket silently cannot open the salon - and the only
 * symptom is a message that will not decrypt, on the device its owner is least likely to be holding
 * when they notice.
 *
 * THE SECOND DEVICE IS NEVER TOUCHED HERE, and that is the assertion rather than a convenience. Any
 * gesture on the phone - opening the salon, even foregrounding the app - could be the thing that
 * repairs it, and a check that drives both devices cannot tell "it was carried" from "it caught up
 * because I poked it". So the phone is required to be ONLINE and nothing more, and the run's whole
 * claim is a row that appears without it.
 *
 * WHICH DEVICE IS WHICH IS READ, NOT ASSUMED: the ids carry their platform (`web-...` for the
 * browser, `tauri-...` for the phone), so the two leaves of one account are told apart from the
 * server's own table without the harness holding a device id of its own.
 *
 * DEBRIS IS LEFT BEHIND, like every check in this phase. `cleanup.mjs` is the deliberate step.
 */
import { client, realClick } from './chat.mjs';
import {
  createChannel,
  enterCommunities,
  openCommunity,
  selectedChannel,
} from './comm.mjs';
import { channelIdOf, communityDistribution, salonDistribution, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PORTS, VENUE } from './names.mjs';
import { console_ as phoneConsole, pid as phonePid } from './phone.mjs';
import { clientBuild, commitDate, mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);

const run = mark('COMM25');
const salon = `c25-${run.toLowerCase()}`;

const wa = await watch(w1, 'W1');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The platform half of a device id - the only thing that tells one account's two leaves apart. */
const platformOf = (deviceId) => String(deviceId).split('-')[0];

// ── The precondition, and it is not this check's to arrange ───────────────────
// THE ACCOUNT MUST ACTUALLY HOLD TWO DEVICES, and a run where it holds one would pass every
// assertion below by describing a set with nothing missing from it. Read from the COMMUNITY's group,
// which both devices are already on - that is the population the salon's roster is a subset of.
const ownerId = await step('resolve the owner user id', () => userIdOf(OWNER_NAME));
const workspaceId = await step('read the community id', () => workspaceIdOf(VENUE.community));
const community = await step('read the community roster', () =>
  workspaceId ? communityDistribution(workspaceId) : null
);
const ownerDevicesOnCommunity = (community?.devices ?? []).filter((d) => d.userId === ownerId);
const platforms = [...new Set(ownerDevicesOnCommunity.map((d) => platformOf(d.deviceId)))].sort();

// The phone has to be RUNNING, not merely enrolled: a device that is switched off is one the server
// will happily leave a row for while nothing ever reads the seed. `pid()` answers null rather than
// throwing when the phone is absent, so a missing phone costs this check and no other.
const phoneUp = await step('is the phone running', () => phonePid());

// ── AND IT HAS TO BE RUNNING A BUILD THAT HAS THE MECHANISM ───────────────────
// THE PHONE IS NOT ON THE DEPLOYMENT. `frontendDist` is `../build`, so it serves the bundle inside
// its APK and no deploy ever reaches it. The first run of this check, 2026-08-20, came back FAIL
// against an APK built on 2026-08-11 - nine days before per-salon distribution groups existed at
// all. The device could not have joined a group its code has no notion of, and the verdict said
// nothing whatever about the product. That is not a failure to report, it is a question that was
// never asked: a fact the harness could read beforehand instead of learning by failing.
//
// THE THRESHOLD IS A COMMIT, NOT A DATE. This row measures the mechanism b9ed05f7 introduced, so
// that is what is named, and its date is derived from the repository.
const PER_SALON_GROUPS = 'b9ed05f7';
const a1 = await step('read the build the phone is running', async () => {
  const cx = await client(PORTS.A1);
  try {
    return await clientBuild(cx);
  } finally {
    cx.close();
  }
});
// Read while ARMING, before the salon exists - so this reads a fact rather than being the gesture
// that repairs the thing under test. Nothing can be carried into a salon that has not been made.
const phoneHasTheMechanism =
  !!a1 && Date.parse(a1.builtAt) >= Date.parse(commitDate(PER_SALON_GROUPS));

const armed =
  ownerDevicesOnCommunity.length >= 2 &&
  platforms.length >= 2 &&
  !!phoneUp &&
  phoneHasTheMechanism;

// ── W1 creates a private salon, and touches nothing else ──────────────────────
const created = armed
  ? await step('create the private salon on W1', async () => {
      await enterCommunities(w1);
      await openCommunity(w1, VENUE.community);
      await createChannel(w1, salon, { visibility: 'private' });
      await realClick(w1, `[aria-label*=${JSON.stringify(salon)}]`);
      return selectedChannel(w1);
    })
  : null;

const channelId = await step('read the salon id', () =>
  workspaceId && armed ? channelIdOf(workspaceId, salon) : null
);

// ── The claim: the other device arrives on its own ────────────────────────────
// POLLED, because the second device enters the group by its own external commit once it learns the
// salon exists - the delay is the phone's next sync, which is a fact about the fleet and not a knob.
// The poll returns the moment both platforms are present, so a wide window costs only the failures.
const roster = channelId
  ? await step('wait for both of the owner devices on the salon', async () => {
      const deadline = Date.now() + 90_000;
      let last = null;
      for (;;) {
        last = salonDistribution(channelId);
        const mine = (last?.devices ?? []).filter((d) => d.userId === ownerId);
        const seen = [...new Set(mine.map((d) => platformOf(d.deviceId)))].sort();
        if (seen.length >= 2) return { devices: mine, platforms: seen, waitedMs: Date.now() - deadline + 90_000 };
        if (Date.now() > deadline) return { devices: mine, platforms: seen, waitedMs: 90_000, exhausted: true };
        await new Promise((r) => setTimeout(r, 3000));
      }
    })
  : null;

// ── What the phone itself says, read WITHOUT touching it ──────────────────────
// A ROUTING ROW IS THE SERVER'S INTENT AND THE CONSOLE IS THE DEVICE'S RECEIPT, and COMM-8 is the
// reason both are read: a row can exist for a device that never stored anything. logcat is the only
// way to read the phone's console while leaving the phone alone - opening its devtools would be a
// gesture, and this check's whole claim is that no gesture was needed.
const phoneSaid = channelId
  ? await step('read the phone console for this salon', () => {
      const needle = channelId.slice(0, 8);
      return phoneConsole(4000).filter((l) => l.includes('[GRAINE]') && l.includes(needle));
    })
  : null;

const bothPlatforms = (roster?.platforms ?? []).length >= 2;

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 ||
      created !== salon ||
      !channelId ||
      salonDistribution(channelId)?.isPrivate !== true ||
      !bothPlatforms
    ? 'FAIL'
    : 'PASS';

const gated = gate(verdict, { W1: await report(wa) });

record('COMM-25', gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  salon,
  channelId,
  owner: ownerId ? ownerId.slice(0, 8) : null,
  // The arming, recorded whatever it said: VACUOUS has to name which half was missing, and a PASS
  // has to carry the proof that "both devices" was a set of two rather than a set of one.
  armed,
  phoneRunning: !!phoneUp,
  // WHICH BUILD THE PHONE READ, on every row and not only on a failure: this is the one check in
  // the phase whose two devices can be on different builds, and a reader has to be able to see it.
  a1Build: a1?.commit ?? null,
  a1BuiltAt: a1?.builtAt ?? null,
  phoneHasTheMechanism,
  ownerDevicesOnCommunity: ownerDevicesOnCommunity.map((d) => `${platformOf(d.deviceId)}:${d.status}`),
  communityPlatforms: platforms,
  // THE EVIDENCE. Platforms rather than device ids: an id is 64 hex characters of account identity
  // and this record is read by people, one of whom might paste it somewhere public.
  salonPlatforms: roster?.platforms ?? null,
  salonOwnerDeviceCount: roster?.devices.length ?? null,
  salonWaitedMs: roster?.waitedMs ?? null,
  // The phone's own words, which no gesture provoked. Empty is not a failure on its own - the
  // routing row is the assertion - but a PASS with nothing here is a row nobody has confirmed.
  phoneSaid,
  failures,
});

console.log(`\n===== W1: ${consoleLines(wa.cx).length} console lines =====`);
for (const l of consoleLines(wa.cx)) console.log(`  ${l}`);

w1.close();
