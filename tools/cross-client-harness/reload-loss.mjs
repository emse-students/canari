/**
 * Is the loss about FORWARDING, or about RELOADING?
 *
 * FWD-5 lost 4/4, always with the same fingerprint: the server answers 201, and the receiver logs
 * `Ciphertext generation out of bounds 110` -> `SecretReuseError` -> `Duplicate ... - silent ACK`.
 * The generation number is IDENTICAL every run, which points at the sender resuming from a
 * persisted MLS state that is behind the ratchet it already used - i.e. at the reload, not at the
 * forward.
 *
 * So: reload, then send three PLAIN messages to the DM. If only the first is lost, the loss is the
 * sender re-using a generation the receiver has already consumed, and forwarding is innocent.
 */
import { client, ensureChat, openConversation, send, countMessage, awaitMessage } from './chat.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.argv[2] || 2);

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

for (let round = 0; round < ROUNDS; round++) {
  await w1.send('Page.reload');
  await sleep(7000);
  await ensureChat(w1);
  await openConversation(w1, 'PEER DISPLAY NAME');
  await sleep(1500);

  const o2 = await watch(w2, `reload-${round}-W2`);
  const row = [];
  for (let i = 0; i < 3; i++) {
    const m = mark(`RL${round}${i}`);
    const at = Date.now();
    await send(w1, `${m} plain send #${i} after a reload`);
    const ms = await awaitMessage(w2, m, 25000).then(() => Date.now() - at, () => null);
    row.push({ i, marker: m, delivered: (await countMessage(w2, m)) === 1, ms });
    await sleep(1200);
  }
  const o = await report(o2);
  console.log(
    JSON.stringify({ round, sends: row, receiverNotable: o.notable, receiverClean: o.clean })
  );
}
process.exit(0);
