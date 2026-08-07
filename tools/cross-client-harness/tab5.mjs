/**
 * TAB-5 - reload fired within ~100 ms of submitting a message.
 *
 * "Never lost, never doubled" is the whole assertion, and it has two sides that must BOTH be
 * checked, because the campaign has already produced one bug on each: the receiver can lose it
 * (WP-LOSS-1, a rewound ratchet) and the SENDER can lose its own echo across a load (WP-ECHO-1,
 * open). So each round counts the marker on the receiver AND on the sender after the reload.
 *
 * `send()` cannot be reused: it waits for the composer to empty and for delivery, which is exactly
 * the window being cut. The submit here is fire-and-forget - click, then reload as fast as the
 * driver allows - and the elapsed time between the two is REPORTED, because a check that claims to
 * reload "within 100 ms" and actually took 400 is testing something else.
 */
import { client, ensureChat, openConversation, countMessage, awaitMessage, evaluate, COMPOSER, SEND_ENABLED } from './chat.mjs';
import { realClick, activate, until } from './cdp.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.argv[2] || 3);

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');

async function reopenW1() {
  await sleep(7000);
  await ensureChat(w1);
  await openConversation(w1, 'PEER DISPLAY NAME');
  await sleep(1500);
}

const rows = [];
for (let i = 0; i < ROUNDS; i++) {
  const m = mark(`TAB5X${i}`);
  const o1 = await watch(w1, `TAB5-${i}-W1`);
  const o2 = await watch(w2, `TAB5-${i}-W2`);

  await realClick(w1, COMPOSER);
  await evaluate(w1, `document.querySelector('${COMPOSER}').focus()`);
  await w1.send('Input.insertText', { text: `${m} reload right after submit` });
  await until(w1, SEND_ENABLED, 5000, 50);

  const at = Date.now();
  await activate(w1, 'text=Envoyer le message');
  // No wait: the point is to tear the document down inside the send's own async tail.
  await w1.send('Page.reload').catch(() => null);
  const gap = Date.now() - at;

  await reopenW1();
  // Give the receiver room beyond the ~700 ms a healthy round takes.
  await awaitMessage(w2, m, 20000).catch(() => null);
  await sleep(2000);

  const onReceiver = await countMessage(w2, m);
  const onSender = await countMessage(w1, m);
  const [r1, r2] = [await report(o1), await report(o2)];

  const row = {
    round: i,
    marker: m,
    msFromSubmitToReload: gap,
    onReceiver,
    onSender,
    verdict: onReceiver === 1 && onSender === 1 ? 'PASS' : 'FAIL',
    senderNotable: r1.notable,
    receiverNotable: r2.notable,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const bad = rows.filter((r) => r.verdict !== 'PASS');
console.log(`\n${rows.length - bad.length}/${rows.length} rounds clean (exactly one copy on each side)`);
process.exit(bad.length ? 1 : 0);
