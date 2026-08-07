#!/usr/bin/env node
/**
 * Verifies that pinching a PDF zooms ABOUT THE PINCHED POINT - the thing the previous check missed.
 *
 * The earlier run asserted only that the zoom level changed, which was true of a build the user
 * then reported as zooming "pas a l'endroit qu'on veut". The assertion here is the observable the
 * user was complaining about, and it is deliberately independent of the implementation's formula:
 * a CONTENT point is identified before the gesture (a page index plus a fraction of that page's
 * box), and after the settle the same content point must still be under the same screen coordinate.
 * Re-deriving `focalScroll` here would only re-test the unit tests; this tests the wiring.
 */
import { client, evaluate, realClick } from './chat.mjs';

const port = Number(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222
);
const cx = await client(port, null, { focus: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Column geometry, the scroll offsets, and every page box in viewport coordinates. */
const geometry = () =>
  evaluate(
    cx,
    `(function () {
      const sc = document.querySelector('[role="document"]');
      const col = sc && sc.querySelector('div[style*="width"]');
      if (!sc || !col) return JSON.stringify({ readerOpen: false });
      const scr = sc.getBoundingClientRect();
      const style = col.getAttribute('style') || '';
      const pages = Array.from(col.children).map(function (el, i) {
        const r = el.getBoundingClientRect();
        const img = el.querySelector('img');
        return {
          i: i,
          left: r.left, top: r.top, width: r.width, height: r.height,
          imgW: img ? Math.round(img.getBoundingClientRect().width) : null,
          natW: img ? img.naturalWidth : null,
        };
      });
      return JSON.stringify({
        readerOpen: true,
        widthPct: (style.match(/width:\\s*([\\d.]+)%/) || [null, null])[1],
        liveScale: (style.match(/scale\\(([\\d.]+)\\)/) || [null, null])[1],
        origin: (style.match(/transform-origin:\\s*([^;]+)/) || [null, null])[1],
        scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop,
        maxScrollLeft: sc.scrollWidth - sc.clientWidth,
        maxScrollTop: sc.scrollHeight - sc.clientHeight,
        box: { left: scr.left, top: scr.top, width: scr.width, height: scr.height },
        pages: pages,
      });
    })()`
  );

/** Two-finger pinch centred on an arbitrary screen point, not on the viewport centre. */
async function pinchAt(fx, fy, { from = 140, to = 430, steps = 14 } = {}) {
  const pt = (id, dx) => ({
    x: Math.round(fx + dx),
    y: Math.round(fy),
    id,
    radiusX: 12,
    radiusY: 12,
    force: 1,
  });
  const send = (type, half) =>
    cx.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [pt(1, -half), pt(2, half)],
    });

  await send('touchStart', from / 2);
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    await send('touchMove', (from + ((to - from) * i) / steps) / 2);
    await sleep(40);
  }
  await send('touchEnd', to / 2);
}

/** Waits for the settled zoom to stop moving - a page is re-rasterised, which is not instant. */
async function settle(previousPct) {
  let last = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const g = JSON.parse(await geometry());
    const stable = last && g.widthPct === last.widthPct && g.pages[0]?.imgW === last.pages[0]?.imgW;
    if (stable && g.widthPct !== previousPct) return g;
    last = g;
  }
  return last;
}

let g0 = JSON.parse(await geometry());
if (!g0.readerOpen) {
  console.log('[anchor] reader closed, opening it');
  console.log('[anchor] open ->', JSON.stringify(await realClick(cx, 'text=ParlerMarteau')));
  await sleep(4000);
  g0 = JSON.parse(await geometry());
}
if (!g0.readerOpen) {
  console.log('[anchor] VERDICT: reader did not open - cannot measure the gesture');
  process.exit(2);
}

// Scroll off the top on purpose: at scrollTop 0 a wrong implementation and a right one can agree,
// because the correction the defect was missing is partly indistinguishable from staying put.
await evaluate(cx, `document.querySelector('[role="document"]').scrollTop = 260; 'ok'`);
await sleep(900);
g0 = JSON.parse(await geometry());
console.log(
  '[anchor] before',
  JSON.stringify({
    widthPct: g0.widthPct,
    scrollTop: g0.scrollTop,
    scrollLeft: g0.scrollLeft,
    pages: g0.pages.length,
  })
);

// Focal point: middle of the container horizontally, 55% down - away from every edge, so the
// scroll correction is never clamped and a clamp cannot be mistaken for a correct anchor.
const fx = g0.box.left + g0.box.width * 0.5;
const fy = g0.box.top + g0.box.height * 0.55;

const target = g0.pages.find((p) => fy >= p.top && fy <= p.top + p.height && p.height > 20);
if (!target) {
  console.log('[anchor] VERDICT: no page under the focal point - cannot identify a content point');
  process.exit(2);
}
// The content point, expressed so it survives a re-layout: which page, and where within it.
const frac = { x: (fx - target.left) / target.width, y: (fy - target.top) / target.height };
console.log(
  `[anchor] focal (${Math.round(fx)}, ${Math.round(fy)}) is page ${target.i} at ` +
    `fraction (${frac.x.toFixed(4)}, ${frac.y.toFixed(4)})`
);

await pinchAt(fx, fy);
const g1 = await settle(g0.widthPct);
console.log(
  '[anchor] after',
  JSON.stringify({
    widthPct: g1.widthPct,
    scrollTop: g1.scrollTop,
    scrollLeft: g1.scrollLeft,
    liveScale: g1.liveScale,
    origin: g1.origin,
  })
);

const zoomed = Number(g1.widthPct) > Number(g0.widthPct);
const after = g1.pages[target.i];
const nowX = after.left + after.width * frac.x;
const nowY = after.top + after.height * frac.y;
const driftX = nowX - fx;
const driftY = nowY - fy;

// Tight on purpose. The no-correction build drifted by (395, 1370); the ratio-based correction by
// (-17, -49), that 48 px being the unscaled padding + gutter above the pinched page. At 12 px this
// check fails against BOTH of them, so it cannot pass on a regression to either.
const TOLERANCE = 12;
const anchored = Math.abs(driftX) <= TOLERANCE && Math.abs(driftY) <= TOLERANCE;

console.log(
  `[anchor] content point moved (${driftX.toFixed(1)}, ${driftY.toFixed(1)}) px, tolerance ${TOLERANCE}`
);
console.log(
  `[anchor] VERDICT: ${zoomed && anchored ? 'PASS' : 'FAIL'} ` +
    `(zoom ${g0.widthPct}% -> ${g1.widthPct}%, anchored=${anchored})`
);
process.exit(0);
