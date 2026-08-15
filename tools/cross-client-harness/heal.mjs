/**
 * After the generation-gap escalation: does the conversation HEAL, i.e. does the NEXT message
 * arrive? The frame that triggered the escalation is unrecoverable by construction; the only
 * question a verification can ask is whether the group works again afterwards.
 */
import { client, ensureChat, openConversation, awaitMessage, send, countMessage } from './chat.mjs';
import { mark } from './results.mjs';
import * as phone from './phone.mjs';
import { PORTS, peerNameFor } from './names.mjs';

phone.wake();
phone.launch();
await new Promise((r) => setTimeout(r, 5000));
phone.forwardDevtools(PORTS.A1);
const a1 = await client(PORTS.A1, 'tauri.localhost');
await ensureChat(a1).catch(() => null);
await openConversation(a1, peerNameFor('A1')).catch(() => null);

const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

for (let round = 1; round <= 3; round++) {
  const m = mark('HEAL');
  const t0 = await send(w2, `${m} round ${round}`);
  const arrived = await awaitMessage(a1, m, 90_000).then(() => Date.now() - t0, () => null);
  const count = await countMessage(a1, m);
  console.log(JSON.stringify({ round, marker: m, arrivedInMs: arrived, count }));
  await new Promise((r) => setTimeout(r, 4000));
}
process.exit(0);
