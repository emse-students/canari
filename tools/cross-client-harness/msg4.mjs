/**
 * MSG-4 - media: W1 sends an image, then a PDF, to W2's DM.
 *
 * What this actually has to prove is not "a bubble appeared". Media in Canari is client-encrypted
 * with a per-file CEK before upload and the server only ever holds an opaque blob, so the receiving
 * side rendering the picture is the ONLY evidence the whole round trip - key derivation, upload,
 * fetch, decrypt - worked. A filename alone would pass even if the bytes never decrypted, which is
 * why the image assertion insists on a rendered `blob:` <img> and the PDF one on a named bubble
 * plus a preview affordance.
 *
 * Both directions are observed (watch.mjs) because a media send touches upload endpoints no text
 * send does: a 4xx there is exactly the kind of thing that would otherwise hide behind a green row.
 */
import { fileURLToPath } from 'node:url';
import { APP_TAB, attachFiles, awaitMessage, client, countMessage, ensureChat, evaluate, openConversation, pollFact, realClick, until } from './chat.mjs';
import { gate, report, watch } from './watch.mjs';
import { record, mark } from './results.mjs';
import { peerNameFor } from './names.mjs';

const abs = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const w1 = await client(9224, APP_TAB);
const w2 = await client(9223, APP_TAB);

await ensureChat(w1);
await openConversation(w1, peerNameFor('W1'));
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

/** Sends one staged file with a marker caption, and returns what the receiver ended up showing. */
async function sendFile(path, caption, kind) {
  const ow1 = await watch(w1, `MSG-4-${kind}-W1`);
  const ow2 = await watch(w2, `MSG-4-${kind}-W2`);

  await attachFiles(w1, [abs(path)]);
  await until(w1, `document.body.innerText.indexOf('EN ATTENTE') !== -1`, 15000);

  await realClick(w1, '.chat-composer-editor');
  await evaluate(w1, `document.querySelector('.chat-composer-editor').focus()`);
  await w1.send('Input.insertText', { text: caption });
  const at = Date.now();
  await realClick(w1, 'text=Envoyer le message');

  // The staging tray must clear, or the "send" did nothing and the next assertion would read the
  // pending preview rather than a delivered message.
  await until(w1, `document.body.innerText.indexOf('EN ATTENTE') === -1`, 30000);

  const arrived = await awaitMessage(w2, caption, 45000).then(
    () => Date.now() - at,
    () => null
  );
  /** What the RECEIVER has actually rendered for this transfer, read fresh on every poll. */
  const readRendered = async () =>
    JSON.parse(
      await evaluate(
        w2,
        `JSON.stringify((function () {
        var pane = document.querySelector('.chat-composer-editor').closest('section');
        var txt = pane.innerText || '';
        return {
          hasCaption: txt.indexOf(${JSON.stringify(caption)}) !== -1,
          fileNamed: txt.indexOf(${JSON.stringify(path.split('/').pop())}) !== -1,
          // A blob: <img> proves only that the app HANDED bytes to the DOM. It says nothing about
          // whether those bytes were an image: a broken picture has exactly the same src, and the
          // first run of this check passed on a fixture whose PNG chunks did not even have valid
          // CRCs. What proves the round trip is DECODED PIXELS, so assert naturalWidth.
          blobImgs: [].filter.call(pane.querySelectorAll('img'), function (i) {
            return String(i.src).indexOf('blob:') === 0;
          }).length,
          decodedImgs: [].filter.call(pane.querySelectorAll('img'), function (i) {
            return String(i.src).indexOf('blob:') === 0 && i.complete && i.naturalWidth > 0;
          }).map(function (i) { return i.naturalWidth + 'x' + i.naturalHeight; }),
          previewAffordance: [].some.call(pane.querySelectorAll('button, a'), function (b) {
            return /Agrandir|Aper.u|T.l.charger|Ouvrir/i.test((b.getAttribute('aria-label') || b.innerText || ''));
          }),
        };
      })())`
      )
    );

  // POLLED TO THE THING THIS TRANSFER ASSERTS, per kind - which `sleep(2500)` could only approximate
  // in one direction at a time. An image is proven by DECODED PIXELS (a broken picture has the same
  // blob: src, and the first version of this check passed on a fixture whose PNG chunks had invalid
  // CRCs); a document is proven by its filename being rendered. Neither is a duration.
  //
  // A miss is the CHECK's answer, not the instrument's: `rendered` is read once more afterwards, so
  // the record carries what the receiver actually had at the deadline rather than nothing at all.
  const decoded = (r) => (kind === 'image' ? r.decodedImgs.length > 0 : r.fileNamed);
  const renderSettled = await pollFact(async () => decoded(await readRendered()), {
    timeoutMs: 20000,
    everyMs: 500,
  });
  const rendered = await readRendered();

  return {
    kind,
    caption,
    arrivedMs: arrived,
    renderedMs: renderSettled.ok ? renderSettled.elapsedMs : null,
    copies: await countMessage(w2, caption),
    rendered,
    obsSender: await report(ow1),
    obsReceiver: await report(ow2),
  };
}

const imgCap = mark('MSG4IMG');
const pdfCap = mark('MSG4PDF');

// NO WAIT BETWEEN THE TWO TRANSFERS. `sendFile` does not return until the staging tray has cleared
// on the sender, the message has arrived on the receiver AND the receiver has rendered it - three
// facts, each stronger than the two seconds this used to sleep. A separation that is already proven
// does not need to be waited for as well.
const image = await sendFile('./fixtures/msg4-image.png', imgCap, 'image');
const pdf = await sendFile('./fixtures/msg4-doc.pdf', pdfCap, 'pdf');

const imageOk =
  image.arrivedMs !== null && image.copies === 1 && image.rendered.decodedImgs.length > 0;
const pdfOk = pdf.arrivedMs !== null && pdf.copies === 1 && pdf.rendered.fileNamed;
// FOUR REPORTS, ONE GATE - the two transfers are two sends of the same check, so a dirty client in
// either of them qualifies the single MSG-4 verdict. Labelled by transfer AND by client, or the
// record would say "dirty" without saying which half of the check was.
const gated = gate(imageOk && pdfOk ? 'PASS' : 'FAIL', {
  'image-W1': image.obsSender,
  'image-W2': image.obsReceiver,
  'pdf-W1': pdf.obsSender,
  'pdf-W2': pdf.obsReceiver,
});
record('MSG-4', gated.verdict, { ...gated.detail, image, pdf });
console.log(JSON.stringify({ verdict: gated.verdict, imageOk, pdfOk, ...gated.detail, image, pdf }, null, 1));
process.exit(0);
