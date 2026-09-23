#!/usr/bin/env node
/**
 * INVESTIGATION - a photo whose bubble reads the NOTIFICATION's caption, for good.
 *
 *   bun archive/photoprev.mjs --mode killed|background|foreground|elsewhere
 *   bun archive/photoprev.mjs --all
 *
 * **THE REPORT.** 2026-09-22, on `0.18.18`: two media bubbles in a DM reading the push's own caption
 * instead of the pictures, still reading it hours later and after the app had been reopened. That
 * caption has exactly ONE producer in the whole tree - `proto_fields.rs`, the NOTIFICATION preview -
 * so a bubble carrying it is an FCM cache row that nothing ever upgraded. Both previously known
 * causes are refuted for that occurrence: the 2026-09-17 overwrite guard is IN that build, and the
 * native push decrypt is read-only (`background.rs`, "these never persist `mls.bin`"), so the frame
 * was not consumed out from under the drain.
 *
 * **WHAT THIS MEASURES, AND WHY IT IS FOUR RUNS RATHER THAN ONE.** The preview is written at BOOT by
 * `consumeFcmCache`, and the envelope arrives whenever the drain reaches it. Which of the two writes
 * last is decided by the app's lifecycle at reception, and nothing else - so the lifecycle IS the
 * variable, and every value of it is taken:
 *
 * - `killed`      - the ordinary push case. Preview first, envelope second.
 * - `background`  - the process is alive and cached; FCM still runs, the socket may or may not.
 * - `foreground`  - the app is open ON the conversation. The envelope is rendered live and the
 *                   native side STILL writes a cache entry (no foreground check) - the exact state
 *                   the 2026-09-17 guard exists for, and the one a later boot used to destroy.
 * - `elsewhere`   - open, but not on that conversation: live ingest without a rendered pane.
 * - `resumed`     - **the order the four above cannot produce.** The preview is injected in one
 *                   session and the envelope arrives in the NEXT one, so the upgrade meets a row
 *                   read back from DISK rather than one it wrote itself minutes earlier. The
 *                   queue and the socket are stopped between the push and the first launch and
 *                   started again before the second, so the frame is stranded in `queued_message`
 *                   for exactly one session - see {@link FRAME_SERVICES}.
 *
 * **AND EVERY RUN IS READ TWICE, WHICH IS THE WHOLE POINT.** The screen is read once when the
 * conversation is opened, and again after a kill and a cold relaunch. That second read is what
 * separates the two shapes the report leaves open: a row overwritten in STORAGE reads the caption
 * both times, a row correct on disk and wrong on SCREEN shows the picture after the restart.
 *
 * **NO CAPTION TYPED, AND THAT IS A PRECONDITION RATHER THAN A CONVENIENCE.** `proto_fields.rs`
 * renders `caption.unwrap_or_else(|| <the photo caption>)`, so a marker typed into the composer
 * would replace the one string this investigation is about. The transfer is therefore identified by
 * COUNTING what the pane holds, the way a person would.
 */
import { basename } from 'node:path';
import {
  APP_TAB,
  attachFiles,
  client,
  ensureChat,
  evaluate,
  openConversation,
  parkConversation,
  pollFact,
  realClick,
  until,
} from '../chat.mjs';
import { execFileSync } from 'node:child_process';
import { estateReverse, sitePort } from '../a1apk.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlockClient } from './pingate.mjs';
import { fixture } from '../fixtures.mjs';
import { report, watch } from '../watch.mjs';
import { requireFreshFcmLink } from '../fcmlink.mjs';
import * as phone from '../phone.mjs';
import { ACCOUNT_OF, PORTS, peerNameFor } from '../names.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED - `useDevice` in `phone.mjs`.
phone.useDevice('A1');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const MODES = argv.includes('--all')
  ? ['killed', 'background', 'foreground', 'elsewhere', 'resumed', 'stranded', 'restored']
  : [opt('mode', 'killed')];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) =>
  console.error(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${s}`);

/** The caption the native notification builder renders for an uncaptioned image. */
const PHOTO_CAPTION = '\u{1F4F7} Photo';

/**
 * What the phone's conversation pane HOLDS, counted rather than matched.
 *
 * `previewText` is the defect made countable: how many times the notification's own caption is
 * rendered in the transcript. `decoded` is the proof the opposite way round - a `blob:` <img> with
 * real pixels, the same assertion MSG-4 makes, because a broken picture has the same `src`.
 */
const PANE_READ = `(function () {
  var ed = document.querySelector('.chat-composer-editor');
  var pane = ed ? ed.closest('section') : document.body;
  var txt = (pane.innerText || '');
  var needle = ${JSON.stringify(PHOTO_CAPTION)};
  var seen = 0;
  for (var i = txt.indexOf(needle); i !== -1; i = txt.indexOf(needle, i + 1)) seen++;
  var imgs = [].slice.call(pane.querySelectorAll('img'));
  var blobs = imgs.filter(function (i) { return String(i.src).indexOf('blob:') === 0; });
  return JSON.stringify({
    previewText: seen,
    blobImgs: blobs.length,
    decoded: blobs
      .filter(function (i) { return i.complete && i.naturalWidth > 0; })
      .map(function (i) { return i.naturalWidth + 'x' + i.naturalHeight; }),
    tail: txt.split('\\n').filter(function (l) { return l.trim(); }).slice(-12)
  });
})()`;

const readPane = async (cx) => JSON.parse(await evaluate(cx, PANE_READ));

/**
 * Foreground the app, unlock the PIN, open the DM, and read the pane.
 *
 * `expectPicture` is what the poll waits for, and it is false for exactly one read - the offline
 * half of `resumed`, where a picture is what must NOT be there. Waiting 25 s for it anyway would
 * spend the wait proving the premise instead of measuring the result.
 */
async function openAndRead(what, { expectPicture = true, tolerant = false } = {}) {
  const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 60_000 });
  if (!up.ok)
    throw new Error(`${what}: the phone never came back on devtools: ${JSON.stringify(up)}`);
  const a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
  try {
    const gateA1 = await unlockClient(a1, PORTS.A1, ACCOUNT_OF.A1, { match: 'tauri.localhost' });
    if (gateA1.verdict !== 'unlocked')
      throw new Error(`${what}: PIN gate ${gateA1.verdict} - ${gateA1.said}`);
    await ensureChat(a1);
    await openConversation(a1, peerNameFor('A1'));
    // The transcript is not on screen the instant the conversation is - a cold start reaches the
    // PLACE first and rebuilds its store from disk after. Polled for pixels, and read regardless.
    await pollFact(
      async () => {
        const p = await readPane(a1);
        return expectPicture ? p.decoded.length > 0 : p.previewText > 0;
      },
      { timeoutMs: tolerant ? 6_000 : 25_000, everyMs: 1000 }
    );
    return await readPane(a1);
  } finally {
    a1.close();
  }
}

/**
 * Boots the app with no estate at all and ends on the cache being DRAINED, not on a screen.
 *
 * The file is read and cleared by one Tauri command, so "the preview is now the row" is a statement
 * the app makes in its own log and nowhere else while the sidebar cannot be drawn. It returns the
 * same shape as {@link openAndRead} so the record stays one table.
 */
async function bootAndWaitForInjection(what) {
  phone.launch();
  const drained = await pollFact(
    async () => phone.console_(4000).some((l) => l.includes('[FCM_CACHE] Injection done')),
    { timeoutMs: 90_000, everyMs: 3000 }
  );
  if (!drained.ok) throw new Error(`${what}: the FCM cache was never drained with no estate up`);
  const injected = phone
    .console_(4000)
    .filter((l) => l.includes('[FCM_CACHE]'))
    .slice(-4);
  return { previewText: injected.length, blobImgs: 0, decoded: [], tail: injected };
}

const w2 = await client(PORTS.W2, APP_TAB);
const w1 = await client(PORTS.W1, APP_TAB);
// W1 HOLDS THE SAME ACCOUNT AS THE HANDSET, and its read receipt is a silent push the phone answers
// by cancelling that conversation's notifications - NOTIF-15 lost a run to exactly this.
await ensureChat(w1);
await parkConversation(w1);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

/** Where each boot's whole console lands - a filtered slice in the record, the rest on disk. */
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'logs');
mkdirSync(OUT, { recursive: true });

const IMAGE = fixture('msg4-image.png');
const estatePort = sitePort();

/**
 * The two containers that carry a FRAME, stopped and started to strand one in the queue.
 *
 * NOT `adb reverse --remove`, WHICH WAS TRIED FIRST AND MEASURED NOTHING. Cutting the whole estate
 * off the phone also cuts `/api/users`, so the sidebar could not resolve the peer's DISPLAY NAME and
 * the conversation was never listed - the run died on its own precondition with
 * `unknownLabelRows: 1`. The queue and the socket are the only two things that must be unreachable;
 * everything else the app needs to draw the screen has to keep answering.
 */
const FRAME_SERVICES = ['canari-local-chat-delivery-service-1', 'canari-local-chat-gateway-1'];
const docker = (verb) => {
  for (const c of FRAME_SERVICES) execFileSync('docker', [verb, c], { stdio: 'pipe' });
};
const results = [];

for (const mode of MODES) {
  stage(`=== mode=${mode}`);

  // -- put the phone in the state under test ---------------------------------------------------
  if (mode !== 'background' && mode !== 'foreground' && mode !== 'elsewhere') {
    await phone.killAndProveDead();
  } else if (mode === 'background') {
    await phone.evictToCache();
  } else {
    const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 60_000 });
    if (!up.ok) throw new Error(`${mode}: phone unreachable before the send: ${JSON.stringify(up)}`);
    const a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
    try {
      const g = await unlockClient(a1, PORTS.A1, ACCOUNT_OF.A1, { match: 'tauri.localhost' });
      if (g.verdict !== 'unlocked') throw new Error(`${mode}: PIN gate ${g.verdict} - ${g.said}`);
      await ensureChat(a1);
      if (mode === 'foreground') await openConversation(a1, peerNameFor('A1'));
      else await parkConversation(a1);
    } finally {
      a1.close();
    }
  }

  // A DEAD FCM LINK REPORTS AS A SILENT PRODUCT - the rig's own precondition for any push row.
  if (mode !== 'foreground' && mode !== 'elsewhere') {
    await requireFreshFcmLink(`PHOTOPREV-${mode}`, stage);
  }

  // THE BASELINE, AND IT IS NOT A FORMALITY. A stuck preview left by an EARLIER run is
  // indistinguishable from one this run produced unless the pane is counted before the send.
  const baseline = await openAndRead(`${mode}/baseline`, { expectPicture: false, tolerant: true });
  stage(`baseline: previewText=${baseline.previewText} decoded=${baseline.decoded.length}`);
  if (mode !== 'background' && mode !== 'foreground' && mode !== 'elsewhere') await phone.killAndProveDead();
  else if (mode === 'background') await phone.evictToCache();

  phone.clearLogcat();
  const sinceDevice = phone.deviceNowMs();
  const ow2 = await watch(w2, `photoprev-${mode}-W2`);

  // -- the send: one image, NO caption ---------------------------------------------------------
  stage('W2 attaches the image');
  await realClick(w2, '.chat-composer-editor');
  await attachFiles(w2, [IMAGE]);
  await until(w2, `document.body.innerText.indexOf('EN ATTENTE') !== -1`, 20_000);
  await realClick(w2, 'text=Envoyer le message');
  await until(w2, `document.body.innerText.indexOf('EN ATTENTE') === -1`, 45_000);
  stage(`sent ${basename(IMAGE)}`);

  // -- the push, where there is one ------------------------------------------------------------
  let notifiedMs = null;
  if (mode !== 'foreground' && mode !== 'elsewhere') {
    notifiedMs = await phone.awaitNotification('Photo', 90_000, sinceDevice);
    stage(`notification after ${notifiedMs}ms`);
  } else {
    await sleep(8000);
  }

  // -- read one: the screen the person would see -----------------------------------------------
  // THE ESTATE IS CUT HERE, NOT EARLIER: the push itself is sent BY the estate, so a cut taken
  // before the send would measure a message nobody ever tried to deliver.
  let offline = null;
  if (mode === 'resumed') {
    docker('stop');
    offline = FRAME_SERVICES.join(', ');
    stage(`frame services stopped: ${offline}`);
  } else if (mode === 'stranded' || mode === 'restored') {
    estateReverse(false, 'photoprev', estatePort);
    offline = `reverse tcp:${estatePort}`;
    stage(`the whole estate cut from the phone: ${offline} down`);
  }

  // A TOTALLY OFFLINE APP CANNOT BE ASKED TO OPEN A CONVERSATION, and the first attempt at this
  // mode died proving it: the sidebar resolves a DM's label from `/api/users`, so the row is never
  // listed and the run fails on its own precondition (`unknownLabelRows: 1`). What this half has to
  // establish is only that the cache was drained into the store, which the app's own log says.
  const first =
    mode === 'stranded' || mode === 'restored'
      ? await bootAndWaitForInjection(`${mode}/first`)
      : await openAndRead(`${mode}/first`, { expectPicture: mode !== 'resumed' });
  stage(`first read: previewText=${first.previewText} decoded=${JSON.stringify(first.decoded)}`);
  const logs = phone.console_(20_000);
  writeFileSync(join(OUT, `photoprev-${mode}-boot1.log`), logs.join('\n'), 'utf8');

  // -- read two: the same conversation after a cold relaunch -----------------------------------
  // `restored` GIVES THE ESTATE BACK TO A RUNNING APP, and that is the whole difference between it
  // and `stranded`: the socket reconnects and the drain runs inside a session whose sidebar never
  // resolved, so the frame is decrypted by a process that may have nowhere to put it. The kill
  // comes after, which is what makes any in-memory absorber final.
  if (mode === 'restored') {
    estateReverse(true, 'photoprev', estatePort);
    stage(`the estate is back while the app RUNS: reverse tcp:${estatePort} up`);
    await sleep(30_000);
  }
  await phone.killAndProveDead();
  if (mode === 'resumed') {
    docker('start');
    // A container that has started is not a container that answers - the phone's very next act is
    // a drain, and a refused one would read as the defect.
    await sleep(15_000);
    stage('frame services restarted');
  } else if (mode === 'stranded') {
    estateReverse(true, 'photoprev', estatePort);
    stage(`the estate is reachable again: reverse tcp:${estatePort} up`);
  }
  const second = await openAndRead(`${mode}/second`);
  stage(`second read: previewText=${second.previewText} decoded=${JSON.stringify(second.decoded)}`);
  const logsAfter = phone.console_(20_000);
  writeFileSync(join(OUT, `photoprev-${mode}-boot2.log`), logsAfter.join('\n'), 'utf8');

  results.push({
    mode,
    notifiedMs,
    first: { previewText: first.previewText, decoded: first.decoded, tail: first.tail },
    second: { previewText: second.previewText, decoded: second.decoded, tail: second.tail },
    shape:
      second.previewText > baseline.previewText
        ? 'STORAGE - the caption survived a cold relaunch'
        : first.previewText > baseline.previewText
          ? 'SCREEN - the caption was on screen only; the disk was right'
          : 'clean - the picture replaced the caption',
    baseline: { previewText: baseline.previewText, decoded: baseline.decoded.length },
    newPreviews: second.previewText - baseline.previewText,
    logs: logs.filter((l) => /FCM_CACHE|ADD_MSG|QUEUE/.test(l)).slice(-40),
    logsAfterRelaunch: logsAfter.filter((l) => /FCM_CACHE|ADD_MSG|QUEUE/.test(l)).slice(-40),
    w2: await report(ow2),
  });
}

console.log(JSON.stringify(results, null, 1));
process.exit(0);
