/**
 * COMM-17: the community rail is reordered by DRAGGING, and the new order is the account's, not the
 * tab's.
 *
 *   bun comm17.mjs
 *
 * A REORDER IS THREE FACTS AND THE FIRST ONE IS THE ONLY GESTURE. What a person does is drag one
 * icon over another; what has to be true afterwards is that the rail redraws in the new order, that
 * the SERVER holds it (`channel_members.sortOrder`, one row per (user, community) - so the order is
 * personal and two accounts may disagree without either being wrong), and that the account's OTHER
 * device shows the same rail. Any two of those can hold while the third does not, and each failure
 * is a different bug: a rail that redraws and never persists is a lost `PATCH`, a server that holds
 * an order the rail ignores is a sort that reads the wrong column, and an order that stops at this
 * browser is a client cache nothing invalidates.
 *
 * THE DRAG IS DRIVEN AS A DRAG, WHICH IS WHY `dragTo` EXISTS. `svelte-dnd-action` starts on
 * MOVEMENT past a threshold, tracks the pointer to choose an insertion index, and commits on
 * release - so a press at one point and a release at another produce no drag at all, and calling
 * `reorderWorkspaces` from the console would test the API this row is not about. Everything below
 * goes through the rail.
 *
 * IT MOVES ITS OWN COMMUNITY AND PUTS IT BACK. The rail holds whatever the account is a member of,
 * and a check has no business leaving somebody's sidebar rearranged - so it builds its own
 * communities, drags one of them to the top, and drags it back to where it started. The return trip
 * is not tidying: a reorder that cannot be undone by the opposite gesture is a defect, and asserting
 * the rail is IDENTICAL to how it began is the strongest statement available about the other
 * communities.
 *
 * THREE IS THE FLOOR, AND IT IS ARGUED. On a rail of two, "moved to the top" and "the list was
 * reversed" are the same observation, and a product that reversed the rail on every drag would pass.
 * With three or more, `nothingElseMoved` - the others in unchanged relative order - is a real
 * assertion.
 *
 * SO IT BUILDS TWO, AND THAT NUMBER WAS MEASURED RATHER THAN CHOSEN. The first version created ONE
 * and leaned on the account already having others; run on 2026-08-21, minutes after `cleanup.mjs`
 * had swept the campaign's debris, it found a rail of TWO and reported VACUOUS - correctly, and
 * uselessly. A check whose arming depends on how much debris happens to be lying around is a check
 * that passes or abstains for reasons that have nothing to do with the product. Two of its own, plus
 * whatever else is there, makes three the floor by construction.
 *
 * The rail can still be below three - an account in no community at all - and that stays VACUOUS,
 * never a FAIL: the question is genuinely unaskable.
 *
 * THE SECOND DEVICE IS THE PHONE, AND IT IS RELOADED ON PURPOSE. Nothing broadcasts a reorder: the
 * server writes `sortOrder` and the next `GET /channels/workspaces/user/me` returns the new order.
 * So "reaches the other device" means A1 shows it after its next list fetch, and the check reloads
 * A1 to force one rather than waiting on a mechanism the product does not have. Its build is
 * recorded next to the result, because A1's APK is deliberately older than the deployment.
 */
import { APP_TAB, client, dragTo, evaluate } from '../chat.mjs';
import {
  createCommunity,
  deleteCommunity,
  enterCommunities,
  listCommunities,
  openCommunity,
} from '../comm.mjs';
import { userIdOf, workspaceOrderOf } from '../grainedb.mjs';
import { ACCOUNT_OF, OWNER_NAME, PORTS } from '../names.mjs';
import { unlockClient } from './pingate.mjs';
import { clientBuild, mark, record, unmet } from '../results.mjs';
import { gate, report, watch } from '../watch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');

const run = mark('COMM17');
const community = `C17 ${run}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The rail button of a community, by the accessible name the app puts on it and nothing else. */
const railButton = (name) => `button[aria-label=${JSON.stringify(name)}]`;

/**
 * The rail, polled until it is the one expected - or until the window closes, holding what it is.
 *
 * A REORDER IS NOT SYNCHRONOUS WITH THE DROP: the list animates (`flipDurationMs: 150`) and the
 * `PATCH` is in flight, so reading once immediately after the release reads a rail mid-flight.
 * Returning what it settled at rather than throwing is what lets the caller report the order it
 * actually got, which is the interesting half of a failure.
 */
async function railSettlingAt(cx, wanted, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = await listCommunities(cx);
  for (;;) {
    if (JSON.stringify(seen) === JSON.stringify(wanted)) return seen;
    if (Date.now() > deadline) return seen;
    await sleep(500);
    seen = await listCommunities(cx);
  }
}

/** The same, for the SERVER's copy: the names in `sortOrder` order, restricted to what the rail knows. */
function serverOrderOf(userId, railNames) {
  const known = new Set(railNames);
  return workspaceOrderOf(userId).filter((w) => known.has(w.name)).map((w) => w.name);
}

/**
 * `order` keeping only the names `held` contains - the comparison to make against a client whose
 * rail is a SUBSET of this one's.
 *
 * A device that holds five of six communities can still hold them in the right order, and that is
 * what this row asks. `serverOrderOf` above has always restricted the server's copy this way; the
 * phone's was compared strictly until 2026-08-27, which is one check applying two standards to the
 * same claim.
 */
const onlyThoseIn = (order, held) => {
  const there = new Set(held ?? []);
  return (order ?? []).filter((n) => there.has(n));
};

/** `list` with the item at `from` moved to sit at index `to` - what a drag is supposed to produce. */
function moved(list, from, to) {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// -- The venue: two communities of our own, so the rail is three deep whatever else is there ---
const ownerId = await step('read the account id', () => userIdOf(OWNER_NAME));

// THE SECOND ONE IS NEVER TOUCHED, and it is not padding. It is the third row `nothingElseMoved`
// needs: with only the dragged community and one bystander, "the others kept their order" is a
// statement about a list of one, which every possible outcome satisfies.
const bystander = `C17b ${run}`;

for (const name of [bystander, community]) {
  await step(`create ${name}`, async () => {
    await enterCommunities(w1);
    await createCommunity(w1, name);
    await openCommunity(w1, name);
  });
}

const railBefore = (await step('read the rail', async () => {
  await enterCommunities(w1);
  return listCommunities(w1);
})) ?? [];

// WHICH OF OURS GETS DRAGGED IS READ OFF THE RAIL, NOT DECIDED HERE. Every community starts at
// `sortOrder` 0 and the app sorts on that column alone, so ties come back in whatever order Postgres
// liked and neither of ours has a position this check may assume. Taking the LATER of the two makes
// `startIndex > 0` true by construction on a rail of three - dragging the top item to the top is a
// gesture with no post-condition, and would pass on a product that ignored the drop entirely.
const ours = [bystander, community];
const subject = railBefore.filter((n) => ours.includes(n)).pop() ?? null;
const startIndex = subject ? railBefore.indexOf(subject) : -1;
const serverBefore = ownerId ? await step('read the order the server holds', () => serverOrderOf(ownerId, railBefore)) : null;

// ARMING IS A MEASUREMENT: both of ours really on the rail, a third row beside them, and something
// above the one about to move.
const armed =
  !!ownerId &&
  railBefore.length >= 3 &&
  ours.every((n) => railBefore.includes(n)) &&
  startIndex > 0;

// -- The gesture: drag it to the top ------------------------------------------------------------
const wantedUp = armed ? moved(railBefore, startIndex, 0) : null;
const dragUp = armed
  ? await step('drag the community to the top of the rail', () =>
      dragTo(w1, railButton(subject), railButton(railBefore[0]))
    )
  : null;
const railAfterUp = armed ? await step('read the rail after the drag', () => railSettlingAt(w1, wantedUp)) : null;
const serverAfterUp = armed && ownerId ? await step('read the order after the drag', () => serverOrderOf(ownerId, railBefore)) : null;

// -- It survives a reload of THIS client --------------------------------------------------------
const railAfterReload = armed
  ? await step('reload W1 and read the rail again', async () => {
      await evaluate(w1, 'location.reload()').catch(() => null);
      await sleep(6000);
      const gateW1 = await unlockClient(w1, PORTS.W1, ACCOUNT_OF.W1, { match: APP_TAB });
      if (gateW1.verdict !== 'unlocked') throw new Error(`W1 did not come back from the PIN: ${gateW1.verdict}`);
      await enterCommunities(w1);
      return railSettlingAt(w1, railAfterUp ?? []);
    })
  : null;

// -- It reaches the account's OTHER device ------------------------------------------------------
const phone = armed
  ? await step('read the rail on the phone', async () => {
      const a1 = await client(PORTS.A1);
      try {
        // THE FAILURE IS RECORDED, NOT SWALLOWED. A `catch(() => null)` here reported `a1Build: null`
        // on a run where the read had thrown, and the campaign's rule is that every A1 verdict names
        // the build it ran on - so "could not be read" has to be distinguishable from "not asked".
        const build = await clientBuild(a1).then(
          (b) => ({ ok: b }),
          (e) => ({ err: e instanceof Error ? e.message : String(e) })
        );
        // `enterCommunities` navigates, which on A1 relaunches the webview and re-locks the PIN -
        // and that is exactly the fetch this half needs, since nothing pushes a reorder.
        await enterCommunities(a1);
        const gateA1 = await unlockClient(a1, PORTS.A1, ACCOUNT_OF.A1, { match: 'tauri.localhost' });
        if (gateA1.verdict !== 'unlocked') return { build, gate: gateA1.verdict, rail: null };
        await enterCommunities(a1);
        return { build, gate: gateA1.verdict, rail: await railSettlingAt(a1, railAfterUp ?? []) };
      } finally {
        a1.close();
      }
    })
  : null;

// -- And the opposite gesture puts it back ------------------------------------------------------
//
// DRAGGED ONTO WHATEVER NOW SITS WHERE IT USED TO BE - which is `railAfterUp[startIndex]`, never
// `railBefore[startIndex]`.
//
// The first version wrote the latter and it names the SUBJECT ITSELF, by definition:
// `startIndex === railBefore.indexOf(subject)`. So the return trip dragged the icon onto its own
// centre - `dragUp` and `dragBack` recorded the same point, `{x:108,y:93}` twice - and the rail
// naturally did not move. Five expectations passed and this one failed, which reads exactly like a
// product that cannot undo a reorder. The position is a fact about the CURRENT rail; the index is
// the only thing carried over from the old one.
const dragBack = armed
  ? await step('drag it back to where it started', () =>
      dragTo(w1, railButton(subject), railButton((railAfterUp ?? railBefore)[startIndex]))
    )
  : null;
const railRestored = armed ? await step('read the rail after the return trip', () => railSettlingAt(w1, railBefore)) : null;

// -- Its own debris goes -------------------------------------------------------------------------
for (const name of [community, bystander]) {
  await step(`delete ${name}`, async () => {
    await enterCommunities(w1);
    await openCommunity(w1, name);
    await deleteCommunity(w1, name);
  });
}

/** The others, in the order they had, with the DRAGGED community out of both sides of the comparison. */
const without = (list) => (list ?? []).filter((n) => n !== subject);

const expectations = {
  // The rail redrew, and the dragged community is where the drop put it.
  theDragMovedItToTheTop: railAfterUp?.[0] === subject,
  // The gesture moved ONE icon. This is the assertion a rail of two cannot make.
  nothingElseMoved: JSON.stringify(without(railAfterUp)) === JSON.stringify(without(railBefore)),
  // The server holds the same order the rail shows - `channel_members.sortOrder`, not a cache.
  theServerHoldsTheNewOrder: JSON.stringify(serverAfterUp) === JSON.stringify(railAfterUp),
  // A reload is a fresh `GET /channels/workspaces/user/me`, so this is the round trip.
  theOrderSurvivesAReload: JSON.stringify(railAfterReload) === JSON.stringify(railAfterUp),
  // The account's other device, which never saw the gesture - compared RESTRICTED TO WHAT THE PHONE
  // HOLDS, exactly as `serverOrderOf` already restricts the server's copy to what the rail knows.
  // Strict array equality here held this one witness to a stricter bar than the other two in the
  // same check, and on 2026-08-27 that cost a FAIL: the phone's rail was W1's order to the letter
  // and one entry short of it, so the ORDER this row exists to measure had plainly arrived. Set
  // membership is a DIFFERENT question with a different fix, so it is recorded as its own field
  // below rather than folded into this one - a rail missing a community is still visible, and still
  // not evidence that a reorder failed to propagate.
  theOrderReachesThePhone:
    phone?.rail != null &&
    JSON.stringify(phone.rail) === JSON.stringify(onlyThoseIn(railAfterUp, phone.rail)),
  // A reorder that cannot be undone by the opposite drag is a defect, and this is also the restore.
  theReverseDragRestoresTheOriginalOrder: JSON.stringify(railRestored) === JSON.stringify(railBefore),
};

failures.push(...unmet(expectations));

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0
    ? 'FAIL'
    : 'PASS';

const gated = gate(verdict, { W1: await report(wa) });

record('COMM-17', gated.verdict, {
  ...gated.detail,
  community,
  bystander,
  // WHICH one was dragged, because it is read off the rail and a reader cannot re-derive it.
  subject,
  armed,
  // WHY it could not be asked, when it could not: a rail of two and a community already on top are
  // different reasons and one word cannot carry both.
  railSize: railBefore.length,
  startIndex,
  railBefore,
  railAfterUp,
  railAfterReload,
  railRestored,
  serverBefore,
  serverAfterUp,
  // The pixels the gestures actually travelled - the first thing to read when a drag does nothing.
  dragUp,
  dragBack,
  // A1's build is named beside its answer, because its APK is deliberately not the deployment.
  // `.commit`, and it was `.build`: `resolveStamp` returns `{ builtAt, commit }`, so the old read
  // was undefined on every run and reported `a1Build: null` beside a build it had read perfectly
  // well - the exact unattributable verdict the stamp exists to prevent.
  a1Build: phone?.build?.ok?.commit ?? null,
  a1BuiltAt: phone?.build?.ok?.builtAt ?? null,
  a1BuildUnreadable: phone?.build?.err ?? null,
  a1Gate: phone?.gate ?? null,
  a1Rail: phone?.rail ?? null,
  // THE OTHER HALF OF THE PHONE'S ANSWER, and not part of any verdict: what W1's rail holds and
  // the phone's does not. `theOrderReachesThePhone` ignores this, so without it a genuinely
  // absent community would be invisible in the record instead of merely not a failure of ORDER.
  a1RailMissing: (railAfterUp ?? []).filter((n) => !(phone?.rail ?? []).includes(n)),
  ...expectations,
  failures,
});

w1.close();
