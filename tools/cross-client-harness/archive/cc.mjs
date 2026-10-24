/**
 * CC-1..4 OF THE 1.4.1 CAMPAIGN - two commits built on the SAME epoch, released together.
 *
 *   bun archive/cc.mjs --row 1    # W1 Adds W4's user while W2 Adds W5's          (W1 W2 W4 W5, U)
 *   bun archive/cc.mjs --row 2    # W1 Removes W4's user while W2 Adds W5's       (W1 W2 W4 W5, U)
 *   bun archive/cc.mjs --row 3    # W1 and W2 both Remove W4's user               (W1 W2 W4, U)
 *   bun archive/cc.mjs --row 4    # a due leaf refresh on W1 races W2's Add       (W1 W2 W4, U)
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2. Each run is ONE draw; a concurrency row's
 * verdict is the set of five (`bun archive/run.mjs CC --repeat 5`). CC-5 is not played here: its
 * premise needs a fifth campaign account (`ccrows.mjs` `CC5_PREMISE`).
 *
 * THE SHAPE, every row: W1 mints the row's own group (`CC<n>-<mark>`, R5-owned) and adds the setup
 * users in ONE bulk Add; every joiner lists it; the epoch is read; then `raceCommits` holds each
 * racing seat's commit POST before the server and releases them together (R3 `hold once` - a rebuilt
 * retry is not held). The gate's own `[COMMIT]` lines since the release are the evidence
 * (`ccrows.mjs`), read AFTER the invariant (R8) so a rebuilt commit sent during it is counted too.
 * `recordObserved` folds in every seat's window, the deploy exclusion (R4) and the server window
 * judged by the row id (R6).
 *
 * CC-4 ARMS THE REFRESH ON THE DEVICE, NOT THE SERVER: the ledger is W1's own `localStorage`
 * (`armLeafRefresh`), backdated on a leaf W1's own setup commit produced; W1's send is the trigger.
 */
import { send } from '../chat.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { addMembers, removeMember } from './addmember.mjs';
import { checkInvariant } from '../invariant.mjs';
import { CC_ROWS, doubleRemoveOwn, parseCommitLines, rebuiltRaceOwn, refreshRaceOwn, refusalCodes } from '../ccrows.mjs';
import {
  armLeafRefresh,
  assertRowOwns,
  awaitListed,
  awaitServer,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  leafLedgerEntry,
  mintRowGroup,
  observersOf,
  openSeats,
  raceCommits,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { GROUP_CREATION_NARRATION } from '../watch.mjs';

const argv = process.argv.slice(2);
const n = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
const id = `CC-${n}`;
if (!CC_ROWS[id]) {
  console.error(`usage: bun archive/cc.mjs --row 1|2|3|4  (no row ${id}; CC-5 is not played here, see ccrows.mjs)`);
  process.exit(2);
}
const spec = CC_ROWS[id];
const since = new Date().toISOString();
let seats = null;

/** The row: set up, race, judge. Returns what `composeVerdict` takes plus the detail. */
async function play() {
  const user = Object.fromEntries(spec.devices.map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const group = await mintRowGroup(cx('W1'), id, user.W1);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx('W1'), group.name, { navigate: false, label: id });
  await addMembers(
    cx('W1'),
    spec.setup.map((d) => displayNameOf(user[d]))
  );
  const premise = [];
  for (const d of spec.setup) {
    if ((await awaitListed(cx(d), group.name, 60_000)) === null) premise.push(`${d} never listed ${group.name} after the setup Add`);
  }
  // THE SETUP MUST HAVE SETTLED: every setup user admitted with an active seat, so the race starts
  // from one epoch every racer holds.
  const settled = await awaitServer(
    group.id,
    (v) => spec.setup.every((d) => (v.seats ?? []).some((s) => s.userId.toLowerCase() === user[d].toLowerCase() && s.status === 'active')),
    30_000
  );
  if (!settled.settled) premise.push('the setup Add did not leave every setup seat active within 30 s');
  if (premise.length) return { premise, detail: { group: group.id, name: group.name } };

  // EVERY RACER STANDS IN THE GROUP'S PANE WITH NOTHING OVER IT, so each gesture starts from the same
  // screen: the setup Add leaves W1's settings panel up, and the gestures open it themselves.
  for (const d of Object.keys(spec.race)) {
    await closeOverlays(cx(d));
    if (d !== 'W1') await openGroup(cx(d), group.name, { navigate: false, label: id });
  }

  // CC-4's PREMISE, READ ONLY HERE: W1's leaf in this group is one its own setup commit produced. The
  // backdate itself happens INSIDE the race, after the faults are armed - any durable frame W1 sends
  // before that (a read receipt is one) would trigger the refresh unheld and spend the race.
  let refresher = null;
  let armed = null;
  if (spec.race.W1?.refresh) {
    const dev = await deviceIdOf(cx('W1'), user.W1);
    const entry = dev ? await leafLedgerEntry(cx('W1'), user.W1, dev, group.id) : null;
    if (!entry || entry.observed) {
      return { premise: [`W1 holds no refresh of its own in ${group.name} (${entry ? 'an observation' : 'no entry'}) - its setup Add did not date its leaf`], detail: { group: group.id } };
    }
    refresher = dev;
  }

  const fromEpoch = serverView(group.id).activeEpoch;
  const raceSince = new Date().toISOString();
  const actions = {};
  for (const [d, act] of Object.entries(spec.race)) {
    if (act.add) actions[d] = () => addMembers(cx(d), [displayNameOf(user[act.add])]);
    else if (act.remove) actions[d] = () => removeMember(cx(d), user[act.remove], group.name, { label: id });
    else if (act.refresh) {
      actions[d] = async () => {
        armed = (await armLeafRefresh(cx(d), user[d], refresher, group.id)).after;
        console.log(`[${id}] ${d}'s refresh ledger backdated to ${new Date(armed.at).toISOString()} - due at its next send`);
        return send(cx(d), `${id} refresh trigger [${rowMessageMark(id, 'T')}]`);
      };
    }
  }
  const race = await raceCommits(seats, actions);

  // A JOINER MUST LIST THE GROUP BEFORE THE INVARIANT CAN SEND TO IT; one that never does is the
  // row's finding (its Add was lost), judged by the roster below - the invariant then names it too.
  const joiners = Object.values(spec.race).map((a) => a.add).filter(Boolean);
  for (const d of joiners) await awaitListed(cx(d), group.name, 60_000);
  await awaitServer(group.id, (v) => v.activeEpoch > fromEpoch, 30_000);

  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets,
    members: spec.members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  const view = serverView(group.id);
  const parsed = parseCommitLines(commitLines(group.id, raceSince));
  const added = joiners.map((d) => user[d]);
  const removedSeats = [...new Set(Object.values(spec.race).map((a) => a.remove).filter(Boolean))];
  let own;
  let ledgerAfter = null;
  if (id === 'CC-3') own = doubleRemoveOwn({ fromEpoch, view, parsed, removed: user[removedSeats[0]], outcomes: race.outcomes });
  else if (id === 'CC-4') {
    ledgerAfter = await leafLedgerEntry(cx('W1'), user.W1, refresher, group.id);
    own = refreshRaceOwn({ fromEpoch, view, parsed, added: added[0], armed, ledgerAfter, outcomes: race.outcomes });
  } else own = rebuiltRaceOwn({ fromEpoch, view, parsed, added, removed: removedSeats.map((d) => user[d]), outcomes: race.outcomes });

  return {
    own,
    invariant,
    vacuousFaults: race.vacuous,
    forgiveLogs: { W1: GROUP_CREATION_NARRATION },
    detail: {
      group: group.id,
      name: group.name,
      fromEpoch,
      releasedAt: race.releasedAt,
      decisions: parsed,
      refusalCodes: refusalCodes(parsed),
      faultRecords: race.records,
      outcomes: race.outcomes,
      ...(armed ? { armedAt: armed.at, ledgerAfter } : {}),
    },
  };
}

try {
  seats = await openSeats(spec.devices, id);
  const out = await play();
  const { verdict, failures } = composeVerdict({
    own: out.own ?? [],
    invariant: out.invariant ?? null,
    vacuousFaults: out.vacuousFaults ?? [],
    premise: out.premise ?? [],
  });
  for (const f of failures) console.log(`[${id}] ${f}`);
  console.log(`[${id}] assertions: ${verdict}`);
  const observers = await observersOf(seats, { logs: out.forgiveLogs ?? {} });
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
