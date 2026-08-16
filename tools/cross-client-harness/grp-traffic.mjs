/**
 * GRP - real traffic in a group reconciles on both sides, in both directions.
 *
 * Written to settle what `recon.mjs` flagged on `GRP2-msp1wknq`: the invitee held one stored row
 * from the moment of the invitation and the inviter held none. A membership event the receiver
 * records and the sender does not looks exactly like the group's first message being lost, and the
 * two have opposite fixes. Traffic separates them - if messages sent AFTER that point appear on
 * both sides with the same ids, the lone row is a receiver-side event and nothing was lost.
 *
 * It doubles as the group half of the delivery check: the DM is exercised constantly and a group is
 * a different MLS path (a commit precedes it, and the roster is larger than two by construction).
 *
 *   node grp-traffic.mjs [GROUP-NAME]
 */
import { client, evaluate, send } from './chat.mjs';
import { openGroup } from './groupnav.mjs';
import { finishObserved, mark } from './results.mjs';
import { watch } from './watch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = process.argv[2] || 'GRP2-msp1wknq';

const idsFor = async (cx, name) =>
  JSON.parse(
    await evaluate(
      cx,
      `(async function () {
        const open = (n) => new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); setTimeout(() => res(null), 4000); });
        const d = (await indexedDB.databases()).filter((x) => x.name.indexOf('CanariDB_') === 0 && x.name.indexOf('Mls') === -1)[0];
        const db = await open(d.name);
        const getAll = (s) => new Promise((res) => { const rq = db.transaction(s, 'readonly').objectStore(s).getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
        const convo = (await getAll('conversations')).find((c) => String(c.name || '') === ${JSON.stringify(name)});
        if (!convo) { db.close(); return JSON.stringify({ err: 'no such conversation' }); }
        const id = String(convo.groupId || convo.id);
        const ids = (await getAll('messages')).filter((m) => String(m.conversationId) === id).map((m) => String(m.id));
        db.close();
        return JSON.stringify({ id: id, ids: ids });
      })()`
    )
  );

const W1 = await client(9224, 'canari-emse.fr', { focus: false });
const W2 = await client(9223, 'canari-emse.fr', { focus: false });

const before = { W1: await idsFor(W1, NAME), W2: await idsFor(W2, NAME) };
for (const [label, s] of Object.entries(before)) {
  if (s.err) throw new Error(`${label}: ${s.err} (${NAME})`);
}
console.log(`[grp] before: W1=${before.W1.ids.length} W2=${before.W2.ids.length}`);

const fromW1 = mark('GRPT1');
const fromW2 = mark('GRPT2');

// THE WINDOW OPENS HERE, not at connect: the `before` reads above walk IndexedDB on both clients and
// are this script's own doing, while everything from this line on is the application's group path -
// a commit, a fan-out over a roster larger than two, and two decrypts. That is the whole subject.
const oW1 = await watch(W1, 'GRP-W1');
const oW2 = await watch(W2, 'GRP-W2');

await openGroup(W1, NAME, { navigate: true, label: 'grp' });
await sleep(1500);
await send(W1, fromW1);
await sleep(3000);

await openGroup(W2, NAME, { navigate: true, label: 'grp' });
await sleep(1500);
await send(W2, fromW2);
await sleep(6000);

const after = { W1: await idsFor(W1, NAME), W2: await idsFor(W2, NAME) };
const gained = {
  W1: after.W1.ids.filter((x) => !before.W1.ids.includes(x)),
  W2: after.W2.ids.filter((x) => !before.W2.ids.includes(x)),
};
console.log(`[grp] gained: W1=${gained.W1.length} W2=${gained.W2.length}`);

/**
 * THE ASSERTION IS ON THE RESULTING SETS, NOT ON WHAT EACH SIDE GAINED.
 *
 * Comparing the gains failed the first run for a reason that was not a defect: the inviter had
 * never stored the membership row the invitee had held since the invitation, and picked it up on
 * first opening the group - so it gained three rows to the invitee's two and the diff of the gains
 * was 1. Nothing was missing; the two sides simply converged at different moments. What the loss
 * class is actually about is where they END, and that is a difference of the full sets.
 */
const onlyW1 = after.W1.ids.filter((x) => !after.W2.ids.includes(x));
const onlyW2 = after.W2.ids.filter((x) => !after.W1.ids.includes(x));

// And both must actually RENDER both markers, which the id sets cannot say - they are ciphertext.
const rendered = async (cx) => {
  const text = await evaluate(
    cx,
    `(function () { var e = document.querySelector('.chat-composer-editor'); return e ? (e.closest('section').innerText || '') : ''; })()`
  );
  return { own: text.includes(fromW1), peer: text.includes(fromW2) };
};
const seen = { W1: await rendered(W1), W2: await rendered(W2) };

// Each side must have gained at least the two messages, the sets must end identical, and both
// markers must RENDER on both - the ids are ciphertext and cannot say anything decrypted.
const ok =
  gained.W1.length >= 2 &&
  gained.W2.length >= 2 &&
  onlyW1.length === 0 &&
  onlyW2.length === 0 &&
  seen.W1.own && seen.W1.peer && seen.W2.own && seen.W2.peer;

console.log(`[grp] rendered: ${JSON.stringify(seen)}`);

/**
 * THE WHOLE GRP PHASE HAS NEVER WRITTEN A ROW, and this is the only script in it.
 *
 * `checks.mjs` lists GRP as covered by this file alone; the file printed `[grp] VERDICT PASS` to
 * stdout and exited on it. So the dashboard's GRP line has only ever been able to say "a script
 * ran", and a run whose terminal has scrolled is a run that left nothing.
 *
 * It observed nothing either, which matters more here than in most places: this is the only check
 * that exercises the MLS group path (a commit, then a fan-out over a roster larger than two), and
 * every failure mode of that path - a commit applied out of order, a member whose ratchet gapped,
 * an epoch that moved under a pending send - announces itself in the console before it ever changes
 * an id set. The id sets are ciphertext; they cannot say why they differ.
 */
await finishObserved(
  'GRP-TRAFFIC',
  ok ? 'PASS' : 'FAIL',
  {
    group: NAME,
    gained: { W1: gained.W1.length, W2: gained.W2.length },
    onlyOnW1: onlyW1.length,
    onlyOnW2: onlyW2.length,
    rendered: seen,
    markers: [fromW1, fromW2],
  },
  { W1: oW1, W2: oW2 },
);
