/**
 * Reconciles the SAME DM as seen by both clients, marker by marker.
 *
 * This is the direct test for WP-LOSS-1: the loss it describes is silent by construction - the
 * sender keeps its optimistic echo, the server returned 201, and only the receiver's store is
 * short. Nothing in either UI says so. So the evidence has to be a set difference between what W1
 * shows and what W2 shows for one conversation, taken after both have loaded the same history.
 *
 * Every campaign message carries a marker of the form PREFIX-<base36>, which is exactly what makes
 * this possible: rows have no id in the DOM, but the text is unique per send.
 */
import { client, ensureChat, openConversation, evaluate } from './chat.mjs';
import { logcatSince, logcatNotable } from './watch.mjs';

const MARKER = /[A-Z][A-Z0-9]{2,11}-[0-9a-z]{8,}/g;

/**
 * Walks the thread from the bottom to the top, ACCUMULATING markers at every step.
 *
 * The list is virtualised: `innerText` holds only the rows currently rendered, so scrolling to the
 * top and reading once returns the OLDEST screenful and silently drops everything between. A run
 * done that way reported a dozen messages as "missing" from one client that it had simply scrolled
 * past, and hid two real losses that had scrolled out of view - the diff looked authoritative and
 * was noise. Reading at each position is the only way the set means what it claims.
 */
async function collect(cx, maxSteps = 60) {
  const marks = new Set();
  let lastTop = -1;
  let stable = 0;
  for (let i = 0; i < maxSteps; i++) {
    const step = await evaluate(
      cx,
      `(function () {
        var pane = document.querySelector('.chat-composer-editor').closest('section');
        var sc = [].filter.call(pane.querySelectorAll('*'), function (e) {
          return e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200;
        })[0];
        if (!sc) return JSON.stringify({ err: 'no-scroller' });
        var text = pane.innerText || '';
        var top = sc.scrollTop;
        sc.scrollTop = Math.max(0, top - Math.round(sc.clientHeight * 0.8));
        return JSON.stringify({ text: text, top: top, atTop: top <= 1 });
      })()`
    );
    const s = JSON.parse(step);
    if (s.err) return { marks: [], how: s.err };
    for (const m of String(s.text).match(MARKER) || []) marks.add(m);
    // "At the top" is not the end: reaching it triggers a fetch of the previous page, so the
    // scroller grows and there is more above. Only a top that stays put across polls is the end.
    if (s.atTop && s.top === lastTop) {
      if (++stable >= 3) return { marks: [...marks], how: `top after ${i + 1} steps` };
    } else {
      stable = 0;
    }
    lastTop = s.top;
    await new Promise((r) => setTimeout(r, 700));
  }
  return { marks: [...marks], how: `capped at ${maxSteps} steps` };
}

async function seen(cx, who, peer) {
  await ensureChat(cx);
  await openConversation(cx, peer);
  await new Promise((r) => setTimeout(r, 1800));
  const { marks, how } = await collect(cx);
  return { who, how, count: marks.length, marks };
}

const t0 = Date.now();
const w1 = await seen(await client(9224, 'canari-emse.fr'), 'W1', 'PEER DISPLAY NAME');
const w2 = await seen(await client(9223, 'canari-emse.fr'), 'W2', 'OWNER DISPLAY NAME');

/**
 * A raw set difference LIES once the history is long enough.
 *
 * Each side loads whatever a fixed number of scroll rounds happens to reach, so the two windows do
 * not coincide: a marker missing from one list may simply be older than that side scrolled. Seen
 * for real - a run reported two markers "only on W2" that were merely outside W1's window, while
 * two genuinely lost ones had scrolled out of view and vanished from the report entirely.
 *
 * Markers carry their own send time (`mark()` = PREFIX + base36 of Date.now() + 3 random chars), so
 * the honest comparison is bounded: only markers at or after the LATEST of the two windows' start
 * points, which is the range both sides provably cover.
 */
const stampOf = (m) => {
  const suffix = m.slice(m.indexOf('-') + 1);
  const t = parseInt(suffix.slice(0, suffix.length - 3), 36);
  return Number.isFinite(t) && t > 1_700_000_000_000 && t < Date.now() + 60_000 ? t : null;
};
/**
 * The window is FIXED, and the run PROVES it reached it.
 *
 * Deriving the bound from the oldest marker each side happened to collect makes the answer depend
 * on how far the scrolling got, which varies run to run - two consecutive runs disagreed, one
 * calling a dozen messages lost that the other reconciled. So: choose a window up front, then
 * require each side to hold at least one marker OLDER than it. That is the only evidence that a
 * side actually covered the range, and without it the diff is not reported at all.
 */
const WINDOW_MS = Number(process.env.RECON_WINDOW_MIN || 90) * 60_000;
const floor = Date.now() - WINDOW_MS;
const reached = (marks) => marks.map(stampOf).some((t) => t !== null && t < floor);
const covered = { w1: reached(w1.marks), w2: reached(w2.marks) };
const inWindow = (m) => {
  const t = stampOf(m);
  return t !== null && t >= floor;
};

const onlyW1 = w1.marks.filter((m) => inWindow(m) && !w2.marks.includes(m));
const onlyW2 = w2.marks.filter((m) => inWindow(m) && !w1.marks.includes(m));

const logcat = logcatNotable(await logcatSince(t0));

console.log(
  JSON.stringify(
    {
      w1: { how: w1.how, count: w1.count },
      w2: { how: w2.how, count: w2.count },
      windowFrom: new Date(floor).toLocaleTimeString('fr-FR'),
      // If either side did not scroll past the window's start, the diff below is meaningless.
      covered,
      trustworthy: covered.w1 && covered.w2,
      comparable: { w1: w1.marks.filter(inWindow).length, w2: w2.marks.filter(inWindow).length },
      onlyW1,
      onlyW2,
      reconciled: onlyW1.length === 0 && onlyW2.length === 0,
      logcatNotable: logcat.slice(0, 10),
    },
    null,
    1
  )
);
process.exit(0);
