#!/usr/bin/env node
/**
 * Verifies the two things the user reported about the PDF reader's zoom:
 *   1) the page must NOT disappear (or be cut) while the next bitmap is computed;
 *   2) walking the zoom ladder must not re-rasterise at every step.
 *
 * Both are properties of a TRANSITION, so neither can be read from a before/after pair - the whole
 * defect lives in between. A MutationObserver installed in the page samples every change to the
 * first page's <img> while the zoom buttons are driven, and the assertions are made on that trace.
 */
import { client, evaluate, realClick } from './chat.mjs';

const port = Number(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222
);
const cx = await client(port, null, { focus: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readerOpen = () =>
  evaluate(cx, `!!document.querySelector('[role="document"] div[style*="width"]')`);

if (!(await readerOpen())) {
  console.log('[render] open ->', JSON.stringify(await realClick(cx, 'text=ParlerMarteau')));
  await sleep(4000);
}
if (!(await readerOpen())) {
  console.log('[render] VERDICT: reader did not open');
  process.exit(2);
}

// Trace installed IN the page: a poll from here samples far too coarsely to prove "never absent".
await evaluate(
  cx,
  `(function () {
    const col = document.querySelector('[role="document"] div[style*="width"]');
    window.__pdfTrace = { frames: [], srcs: [], gaps: 0 };
    const sample = function () {
      const first = col.children[0];
      const img = first && first.querySelector('img');
      const r = first ? first.getBoundingClientRect() : null;
      const entry = {
        hasImg: !!img,
        src: img ? img.getAttribute('src') : null,
        // A cut page shows as a wrapper shorter than the image it contains.
        clipped: !!(img && r && img.getBoundingClientRect().height - r.height > 2),
      };
      window.__pdfTrace.frames.push(entry);
      if (!entry.hasImg || entry.clipped) window.__pdfTrace.gaps++;
      if (entry.src && window.__pdfTrace.srcs[window.__pdfTrace.srcs.length - 1] !== entry.src) {
        window.__pdfTrace.srcs.push(entry.src);
      }
    };
    sample();
    window.__pdfTraceTimer = setInterval(sample, 16);
    return 'armed';
  })()`
);

/**
 * Clicks the zoom-in control. Its aria-label is "Agrandir" - it does NOT contain "zoom", and a
 * `/zoom/i` selector matched nothing while the check happily returned PASS on a ladder it never
 * walked. The control is scoped to the dialog so it cannot collide with the feed underneath.
 */
const zoomIn = () =>
  evaluate(
    cx,
    `(function () {
      const d = document.querySelector('[role="dialog"]');
      const b = d && [].filter.call(d.querySelectorAll('button'), function (x) {
        return (x.getAttribute('aria-label') || '') === 'Agrandir';
      })[0];
      if (!b) return 'absent';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`
  );

const widthPct = () =>
  evaluate(
    cx,
    `(document.querySelector('[role="document"] div[style*="width"]').getAttribute('style').match(/width:\\s*([\\d.]+)%/) || [null,null])[1]`
  );

const ladder = [];
let previous = await widthPct();
for (let step = 0; step < 3; step++) {
  const clicked = await zoomIn();
  await sleep(2500);
  const now = await widthPct();
  ladder.push({ step: step + 1, clicked, from: previous, to: now });
  previous = now;
}
console.log('[render] ladder', JSON.stringify(ladder));

// EVERY action asserts its own post-condition. Without this the check returned PASS on a ladder it
// had never walked: the zoom button's aria-label is "Agrandir", so a `/zoom/i` selector clicked
// nothing, the trace saw one steady bitmap, and "at most one re-render" was trivially satisfied.
const walked = ladder.every((s) => s.clicked === 'clicked' && Number(s.to) > Number(s.from));
if (!walked) {
  console.log('[render] VERDICT: INVALID - the zoom ladder was not actually walked');
  await evaluate(cx, `clearInterval(window.__pdfTraceTimer); 'stopped'`);
  process.exit(2);
}

const trace = JSON.parse(
  await evaluate(
    cx,
    `(function () {
      clearInterval(window.__pdfTraceTimer);
      const t = window.__pdfTrace;
      return JSON.stringify({ frames: t.frames.length, gaps: t.gaps, distinctSrcs: t.srcs.length });
    })()`
  )
);
console.log('[render] trace', JSON.stringify(trace));

// The page must never have been absent or clipped across the whole ladder.
const neverBlank = trace.gaps === 0;
// One rasterisation for the whole 1 -> 1.5 -> 2 -> 3 walk. The first src is the one already on
// screen when the trace armed, so two distinct sources means exactly one re-render.
const oneRender = trace.distinctSrcs <= 2;

console.log(
  `[render] VERDICT: ${neverBlank && oneRender ? 'PASS' : 'FAIL'} ` +
    `(blank/cut frames ${trace.gaps}/${trace.frames}, bitmaps ${trace.distinctSrcs} - was 4 before)`
);
process.exit(0);
