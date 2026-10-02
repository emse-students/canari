/**
 * REEL-1 and REEL-2 on the phone: the camera tab opens a live PORTRAIT preview from a real swipe
 * and gives the camera back when it is left, and a take filmed in the app's own camera is published
 * as a reel the feed then draws as one.
 *
 *   bun archive/run.mjs --file reel.mjs --only 1
 *   bun archive/run.mjs --file reel.mjs --only 2
 *
 * EVERY GESTURE THE PRODUCT CLASSIFIES IS AN OS TOUCH (`adb shell input`). The tab swipe and the
 * shutter both read the finger's path and timing - the shutter tells a TAP (toggle) from a HOLD at
 * 300 ms - and a CDP touch pair is classified differently from a finger (`longPressBubble` in
 * `chat.mjs` measured it). Buttons whose only job is to be pressed are `realClick`s.
 *
 * THE CAMERA GRANT IS ESTABLISHED, NOT ASSUMED. The first open on a phone raises Android's own
 * permission dialog, which is the member's gesture and not this row's subject (the refused state is
 * a component test). So the row grants `CAMERA` and `RECORD_AUDIO` through `pm grant` before it
 * opens anything, and says so in its detail - a precondition the rig sets is stated, never ambient.
 *
 * REEL-2 NEEDS THE ESTATE'S REEL ROUTES. The shutter stays disabled until `GET /api/posts/reel-limits`
 * has answered (the cap is the server's), so a shutter still disabled once the preview is live is
 * reported as `SETUP-FAILED` naming that route - an estate without the server half, not a product
 * defect.
 */
import { execFileSync } from 'node:child_process';
import { client } from '../chat.mjs';
import { evaluate, realClick, until } from '../cdp.mjs';
import { errorDetail, finishObserved, mark } from '../results.mjs';
import { logcatReport, logcatSince, watch } from '../watch.mjs';
import * as phone from '../phone.mjs';
import { PORTS } from '../names.mjs';

phone.useDevice('A1');

const only = process.argv[process.argv.indexOf('--only') + 1];
if (!['1', '2'].includes(only)) throw new Error(`reel.mjs needs --only 1 or --only 2, got '${only}'`);
const ID = `REEL-${only}`;

const adbShell = (...args) =>
  execFileSync('adb', ['-s', phone.serial(), 'shell', ...args], { encoding: 'utf8', timeout: 20_000 });

/** The page's CSS pixels as the screen's device pixels, for `input` - read, never assumed. */
async function toDevice(cx, x, y) {
  const g = JSON.parse(
    await evaluate(cx, `JSON.stringify({ dpr: devicePixelRatio, sx: screenX, sy: screenY })`)
  );
  return [String(Math.round((x + g.sx) * g.dpr)), String(Math.round((y + g.sy) * g.dpr))];
}

/** An OS finger from one CSS point to another over `ms`; to itself, it is a press of that length. */
async function finger(cx, from, to, ms) {
  const [x1, y1] = await toDevice(cx, from.x, from.y);
  const [x2, y2] = await toDevice(cx, to.x, to.y);
  adbShell('input', 'swipe', x1, y1, x2, y2, String(ms));
}

/** The centre of the first element matching `selector`, in CSS pixels. */
async function centre(cx, selector) {
  return JSON.parse(
    await evaluate(
      cx,
      `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
        return JSON.stringify(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null); })()`
    )
  );
}

const CAMERA_LIVE = `document.querySelector('[data-camera-phase]')?.dataset.cameraPhase === 'live'`;

/** What the live preview is, read off the element and its track. */
const PREVIEW = `(() => {
  const v = document.querySelector('[data-camera-phase] video');
  const track = v?.srcObject?.getVideoTracks?.()[0];
  const s = track?.getSettings?.() ?? {};
  const caps = track?.getCapabilities?.() ?? {};
  return JSON.stringify({
    videoWidth: v?.videoWidth ?? 0, videoHeight: v?.videoHeight ?? 0,
    track: track ? { label: track.label, readyState: track.readyState, width: s.width, height: s.height,
      frameRate: s.frameRate, facingMode: s.facingMode ?? null, torch: 'torch' in caps } : null,
  });
})()`;

/** From the feed, a real swipe right onto the camera tab; resolves with how long the preview took. */
async function openCamera(cx) {
  if ((await evaluate(cx, 'location.pathname')) !== '/posts') {
    await realClick(cx, 'a[href="/posts"]');
    await until(cx, `location.pathname === '/posts'`, 10_000);
  }
  const { w, h } = JSON.parse(await evaluate(cx, `JSON.stringify({ w: innerWidth, h: innerHeight })`));
  const t0 = Date.now();
  await finger(cx, { x: w * 0.15, y: h * 0.5 }, { x: w * 0.85, y: h * 0.5 }, 250);
  await until(cx, `location.pathname === '/camera'`, 10_000);
  await until(cx, `${CAMERA_LIVE} && document.querySelector('[data-camera-phase] video')?.videoWidth > 0`, 15_000);
  return Date.now() - t0;
}

phone.wake();
phone.forwardDevtools(PORTS.A1);
const grants = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'];
for (const p of grants) adbShell('pm', 'grant', phone.PKG, p);
const a1 = await client(PORTS.A1, 'tauri.localhost');

// The page's console and the phone's native half: a camera that fails to open, or a re-encode that
// dies, leaves its only trace in one of the two.
phone.clearLogcat();
const nativeFrom = Date.now();
const observed = await watch(a1, 'A1');
/** Records the verdict with both observers - the row's only way to write one. */
const finish = async (id, verdict, detail) =>
  finishObserved(id, verdict, detail, {
    A1: observed,
    'A1-native': logcatReport(await logcatSince(nativeFrom), 'A1'),
  });

if (ID === 'REEL-1') {
  try {
    const toLiveMs = await openCamera(a1);
    const preview = JSON.parse(await evaluate(a1, PREVIEW));
    const portrait = preview.videoHeight > preview.videoWidth;
    // Leaving the tab must GIVE THE CAMERA BACK: the swipe left returns to the feed, and the camera
    // screen - with its stream - is gone from the document.
    const { w, h } = JSON.parse(await evaluate(a1, `JSON.stringify({ w: innerWidth, h: innerHeight })`));
    await finger(a1, { x: w * 0.85, y: h * 0.5 }, { x: w * 0.15, y: h * 0.5 }, 250);
    await until(a1, `location.pathname === '/posts' && !document.querySelector('[data-camera-phase]')`, 10_000);
    const live = preview.track?.readyState === 'live';
    await finish(ID, live && portrait ? 'PASS' : 'FAIL', {
      toLiveMs,
      preview,
      portrait,
      released: true,
      granted: grants,
    });
  } catch (e) {
    await finish(ID, 'FAIL', { error: errorDetail(e), granted: grants });
  }
} else {
  const marker = mark(ID);
  try {
    const toLiveMs = await openCamera(a1);
    const armed = await until(
      a1,
      `!document.querySelector('[data-reel-shutter]')?.disabled`,
      10_000
    ).then(() => true, () => false);
    if (!armed) {
      await finish(ID, 'SETUP-FAILED', {
        reason: 'the shutter stayed disabled with the preview live: GET /api/posts/reel-limits did not answer - an estate without the reels server half',
        toLiveMs,
      });
    } else {
      // A TAP starts a take the release does not end; the next tap ends it.
      const shutter = await centre(a1, '[data-reel-shutter]');
      await finger(a1, shutter, shutter, 80);
      await until(a1, `Number(document.querySelector('[data-reel-ring]')?.dataset.fraction) >= 0.03`, 15_000);
      await finger(a1, shutter, shutter, 80);
      await until(a1, `!!document.querySelector('[data-reel-review]')`, 10_000);
      await realClick(a1, '[data-reel-next]');
      await until(a1, `!!document.querySelector('[data-reel-publish]')`, 10_000);
      await realClick(a1, '[data-reel-caption]');
      await a1.send('Input.insertText', { text: marker });
      await realClick(a1, '[data-reel-publish-submit]');
      const t0 = Date.now();
      // The re-encode runs on the phone before the upload, so the deadline is the preparation's.
      await until(a1, `location.pathname === '/posts' && !document.querySelector('[data-reel-publish]')`, 180_000);
      const publishMs = Date.now() - t0;
      // The caption, then the nearest ancestor holding a reel card: that card is the caption's own
      // post when it holds exactly one. A post drawn as an ordinary video has no reel card at all.
      const drawn = await until(
        a1,
        `(() => {
          const leaf = [...document.querySelectorAll('body *')].find(
            (e) => e.childElementCount === 0 && e.textContent.includes(${JSON.stringify(marker)}));
          for (let n = leaf; n; n = n.parentElement) {
            const cards = n.querySelectorAll('[data-reel-card]').length;
            if (cards) return cards === 1;
          }
          return false;
        })()`,
        30_000
      ).then(() => true, () => false);
      await finish(ID, drawn ? 'PASS' : 'FAIL', { marker, toLiveMs, publishMs, drawnAsReel: drawn, granted: grants });
    }
  } catch (e) {
    await finish(ID, 'FAIL', { marker, error: errorDetail(e), granted: grants });
  }
}
