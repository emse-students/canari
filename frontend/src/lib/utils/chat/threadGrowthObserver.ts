/**
 * The observers that keep a thread's reader in place while its content changes size - taken out of
 * `ChatArea` so a real browser can drive them without mounting the whole pane (the media-frame
 * bench, docs/wiki/frontend/media-frame.md). The judgements are `threadAnchor.ts`'s; this is only
 * the wiring that feeds them the numbers.
 */
import {
  anchorShift,
  appendGlidePx,
  firstRowBelow,
  threadGrowthResponse,
  threadReach,
} from './threadAnchor';
import { Log } from '$lib/utils/Log';

/** What the pane knows about itself at the moment a change is observed. */
export interface ThreadGrowthState {
  /** Whether the reader was at the bottom BEFORE the change - see `ThreadGrowth.wasNearBottom`. */
  wasNearBottom: boolean;
  isLoadingOlder: boolean;
  isEntering: boolean;
}

/** The rows the anchor is chosen among. */
export const THREAD_ROW_SELECTOR = '[id^="msg-"]';

/** The numbers that separate a native anchor, a clamp and a replay: see {@link GlideTrace}. */
interface Geometry {
  top: number;
  height: number;
  box: number;
}

const geometryOf = (scroller: HTMLElement): Geometry => ({
  top: Math.round(scroller.scrollTop),
  height: Math.round(scroller.scrollHeight),
  box: Math.round(scroller.clientHeight),
});

const showGeometry = (g: Geometry | null): string => (g ? `${g.top}/${g.height}/${g.box}` : 'none');

/** One `follow()` pass inside a glide, as the trace keeps it. */
interface TracedPass {
  pass: number;
  cause: 'rows' | 'box';
  atMs: number;
  /** The previous pass's end numbers, cached: a move between two passes is a move nobody wrote. */
  previous: Geometry | null;
  /** Read where the layout is already clean: transforms cancelled, before any write of this pass. */
  suspended: Geometry;
  /** Read right after the pin write and BEFORE the replay; null when this pass pinned nothing. */
  pinned: Geometry | null;
  held: HeldGlide | null;
  response: string;
  travel: number;
  replayPx: number;
  replayTime: number;
}

/** A `scroll` event that moved the pane after a pass of the running glide. */
interface TracedScroll {
  atMs: number;
  top: number;
  delta: number;
}

/**
 * A pin made OUTSIDE `follow()` while the glide ran ({@link pinThreadToEnd}): who wrote, and where
 * the pane stood right after the write, transforms off.
 */
interface TracedWrite {
  writer: string;
  atMs: number;
  placed: Geometry;
}

/** One line of the merged trace, kept in the order it happened. */
type TracedEvent =
  | { kind: 'pass'; seq: number; atMs: number; pass: TracedPass }
  | { kind: 'write'; seq: number; atMs: number; write: TracedWrite }
  | { kind: 'scroll'; seq: number; atMs: number; scroll: TracedScroll };

/** The ring size, for passes and for scroll moves, per glide. */
export const GLIDE_TRACE_MAX_LINES = 8;

/**
 * THE BOUNDED, SILENT TRACE OF `follow()` PASSES INSIDE A GLIDE (iPhone 12, iOS 27, an IMAGE
 * arriving at a pinned DM, chat.md). The pane falls 150-230 px 45-70 ms after the arrival with its
 * reach unchanged. **NOTHING IS WRITTEN AT PASS TIME**: every ordinary message makes a glide, so a
 * line per pass would be noise forever. The passes, the pins made outside them
 * ({@link pinThreadToEnd}) and the scroll moves wait in three rings of {@link GLIDE_TRACE_MAX_LINES}
 * (the oldest drop, counted), and {@link describeGlideFall} prints them merged in time order, at
 * INFO, only when the pane's own measurement finds a fall inside the glide. A new glide empties the
 * rings. No read is added in the glide's window: the numbers are the ones `follow()` and the pin
 * read anyway, taken at points where the layout is clean.
 *
 * How to read it: native anchoring (a) moves `top` at `suspended` with the height UNCHANGED; a
 * clamp (b) moves it with a height that shrank; a scroll move after the last pass (the async case,
 * 45-70 ms later) with stable pass numbers is (b) or an engine move outside the passes - not "nothing
 * found". (c), a stale replay, is a visual offset of the rows and cannot move `scrollTop`. A
 * `glide write by` line between two passes is a second writer: its `top` above the next pass's
 * `suspended` is a pin that read the glide's overflow (the cause found on the iPhone, 2026-11-25).
 */
class GlideTrace {
  private passes: { seq: number; pass: TracedPass }[] = [];
  private writes: { seq: number; write: TracedWrite }[] = [];
  private scrolls: { seq: number; scroll: TracedScroll }[] = [];
  private passCount = 0;
  private writeCount = 0;
  private scrollCount = 0;
  /** The order of every recorded line, to break a tie of two lines at the same millisecond. */
  private seq = 0;
  /** Where the last pass left the pane, and the scroll position the last scroll event saw. */
  lastEnd: Geometry | null = null;
  lastTop = 0;

  /** Records a pass; one that found no glide running opens a new trace. */
  record(pass: Omit<TracedPass, 'pass' | 'previous'>, startsGlide: boolean): void {
    if (startsGlide) {
      this.passes = [];
      this.writes = [];
      this.scrolls = [];
      this.passCount = 0;
      this.writeCount = 0;
      this.scrollCount = 0;
      this.lastEnd = null;
    }
    this.passCount++;
    this.passes.push({
      seq: this.seq++,
      pass: { ...pass, pass: this.passCount, previous: this.lastEnd },
    });
    if (this.passes.length > GLIDE_TRACE_MAX_LINES) this.passes.shift();
    this.lastEnd = pass.pinned ?? pass.suspended;
    this.lastTop = this.lastEnd.top;
  }

  /**
   * Records a pin made outside `follow()` inside the glide - the second writer the iPhone's fall was
   * traced to (chat.md). Its own `scroll` event then reads no move: the write is the line.
   */
  recordWrite(writer: string, atMs: number, placed: Geometry): void {
    if (this.passCount === 0) return;
    this.writeCount++;
    this.writes.push({ seq: this.seq++, write: { writer, atMs, placed } });
    if (this.writes.length > GLIDE_TRACE_MAX_LINES) this.writes.shift();
    this.lastEnd = placed;
    this.lastTop = placed.top;
  }

  /** Records a scroll that moved the pane since the last one seen. */
  recordScroll(atMs: number, top: number): void {
    const delta = top - this.lastTop;
    this.lastTop = top;
    if (delta === 0 || this.passCount === 0) return;
    this.scrollCount++;
    this.scrolls.push({ seq: this.seq++, scroll: { atMs, top, delta } });
    if (this.scrolls.length > GLIDE_TRACE_MAX_LINES) this.scrolls.shift();
  }

  /**
   * The lines of the fall: a header, then the buffered passes, outside writes and scroll moves
   * MERGED IN THE ORDER THEY HAPPENED (time into the glide, then recording order) - a write that
   * lands between two passes reads between them, which is what names a second writer.
   */
  lines(): string[] | null {
    if (this.passCount === 0) return null;
    const dropped = (count: number, kept: number) =>
      count > kept ? ` (${count - kept} older dropped)` : '';
    const events: TracedEvent[] = [
      ...this.passes.map((p): TracedEvent => ({
        kind: 'pass',
        seq: p.seq,
        atMs: p.pass.atMs,
        pass: p.pass,
      })),
      ...this.writes.map((w): TracedEvent => ({
        kind: 'write',
        seq: w.seq,
        atMs: w.write.atMs,
        write: w.write,
      })),
      ...this.scrolls.map((m): TracedEvent => ({
        kind: 'scroll',
        seq: m.seq,
        atMs: m.scroll.atMs,
        scroll: m.scroll,
      })),
    ].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
    return [
      `${this.passCount} follow pass(es)${dropped(this.passCount, this.passes.length)}, ` +
        `${this.writeCount} write(s) outside follow${dropped(this.writeCount, this.writes.length)} and ` +
        `${this.scrollCount} scroll move(s)${dropped(this.scrollCount, this.scrolls.length)} in this glide`,
      ...events.map(showTracedEvent),
    ];
  }
}

/** One merged line of the trace, as {@link describeGlideFall} prints it. */
function showTracedEvent(e: TracedEvent): string {
  if (e.kind === 'pass') {
    const p = e.pass;
    return (
      `glide pass ${p.pass} (${p.cause}, +${Math.round(p.atMs)}ms): top/height/box previous end ` +
      `${showGeometry(p.previous)}, suspended ${showGeometry(p.suspended)}, pinned ` +
      `${p.pinned ? showGeometry(p.pinned) : 'no pin'}; held ` +
      `${p.held ? `${Math.round(p.held.px)}px with ${Math.round(p.held.remaining)}px left` : 'none'}; ` +
      `${p.response}, new travel ${Math.round(p.travel)}px, replay ${Math.round(p.replayPx)}px at ` +
      `${Math.round(p.replayTime)}ms`
    );
  }
  if (e.kind === 'write') {
    const w = e.write;
    return `glide write by ${w.writer} (+${Math.round(w.atMs)}ms): top/height/box ${showGeometry(w.placed)}`;
  }
  const m = e.scroll;
  return `glide scroll move +${Math.round(m.atMs)}ms: top ${m.top} (${m.delta > 0 ? '+' : ''}${m.delta})`;
}

/** The trace and glide of each followed thread, for {@link describeGlideFall}. */
const tracesByScroller = new WeakMap<Element, { trace: GlideTrace; glide: ThreadGlide }>();

/**
 * What a fall found by the pane's scroll measurement owes the log when it happens INSIDE a glide:
 * the lines of the buffered trace, to be written at INFO by the caller. Null when no glide is running
 * (a fall outside one has no pass to blame) or none recorded a pass, so nothing is written then.
 */
export function describeGlideFall(scroller: HTMLElement): string[] | null {
  const entry = tracesByScroller.get(scroller);
  const running = entry?.glide.peek();
  const lines = entry?.trace.lines();
  if (!entry || !running || !lines) return null;
  return [
    `the fall came inside a glide of ${Math.round(running.px)}px, ${Math.round(running.time)}ms in; ${lines[0]}`,
    ...lines.slice(1),
  ];
}

/**
 * Starts following `scroller`: growth below a reader at the bottom is followed, any change above
 * the row at the top of the viewport is undone. Returns the teardown.
 *
 * **FOUR TRIGGERS, ONE CLOSURE, ONE QUANTITY.** The pane changes size from its content (a row added
 * or re-laid out: the `MutationObserver`), from a CHILD's box (a medium decoding to its size, which
 * is not a mutation), from its own box (the soft keyboard, a resize, a panel opening) or from the
 * composer band, whose measured height is the scroller's `padding-bottom`. All four ask `follow()`
 * the same question about the same number. No timer: every trigger is the change itself.
 *
 * **`onPlaced` SAYS WHERE THE PANE WAS PUT, SO THE READER'S FLAG NEVER MISTAKES THE COMPONENT'S OWN
 * MOVE FOR THE READER'S** (the photo DM that lands on older messages, 2026-11-21): it is called with
 * `scrollTop` after every write this observer makes, a pin included - which is also where a browser
 * clamp that a shrinking thread caused ends up, since the pin follows it in the same frame. See
 * `stickToBottomAfterScroll`.
 *
 * **`onGlideEnd` SAYS THE ROWS ARE BACK AT THEIR LAYOUT PLACE** (owner's Android, 1.8.0, 2026-11-25).
 * A glide's transform counts in the scroller's overflow and in every row's box, so a scroll
 * measurement taken during one reads a `scrollHeight` past the real end and separators drawn lower than
 * they stand: the stick-to-bottom flag and the day pill decided then outlive the glide, because its end
 * moves nothing and fires no `scroll`. Called on the glide's own `finish` event - never a clock - so
 * the caller re-takes what it measured mid-glide.
 */
export function observeThreadGrowth(
  scroller: HTMLElement,
  state: () => ThreadGrowthState,
  composerBand?: HTMLElement | null,
  onPlaced?: (scrollTop: number) => void,
  onGlideEnd?: () => void
): () => void {
  // THIS IS THE ONLY ANCHOR, IN EVERY ENGINE - so the browser's own is switched off. Chromium (and
  // Safari from 27) anchor a scroller natively: measured on the media-frame bench, 2026-10-02, an old
  // video above the reader grew by 272 px, Chromium had already moved `scrollTop` by 272 when the
  // observer ran, and this added 272 more - the reader's row left by 253 px UPWARD. WebKit before 27
  // has no native anchoring at all, so leaving it on would make the same code right on an iPhone
  // and wrong on an Android phone. One mechanism, identical everywhere: this one.
  const previousAnchoring = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  // THE REACH, NOT THE HEIGHT: the bottom also moves when the pane's own box shrinks under
  // unchanged content (the soft keyboard rising) - see `threadReach`.
  let previousReach = threadReach(scroller);
  /**
   * THE ROW AT THE TOP OF THE VIEWPORT, and where it was the last time this fired (2026-10-02).
   *
   * `scrollTop` cannot tell a prepend from an append - both grow `scrollHeight` and leave
   * `scrollTop` alone - so a ROW is kept and asked how far it moved. It was the topmost RENDERED
   * row, which a prepend moves exactly as much as the reader's row; but a medium settling BETWEEN
   * the two moved only what the reader was looking at, and the old anchor, above it, reported
   * nothing.
   */
  let anchor: { row: HTMLElement; top: number } | null = null;
  const captureAnchor = () => {
    const rows = scroller.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR);
    const viewportTop = scroller.getBoundingClientRect().top;
    const index = firstRowBelow(
      rows.length,
      (i) => rows[i].getBoundingClientRect().bottom,
      viewportTop
    );
    const row = index >= 0 ? rows[index] : null;
    anchor = row ? { row, top: row.offsetTop } : null;
  };
  captureAnchor();

  let previousClientHeight = scroller.clientHeight;
  const trace = new GlideTrace();
  // THE SCROLL LISTENER IS ARMED FOR THE GLIDE'S DURATION ONLY (see {@link GlideTrace}): it tells a
  // move made inside a pass from one that came after it (the async case), with no forced layout.
  const onTraceScroll = () => {
    const running = glide.peek();
    if (running) trace.recordScroll(running.time, scroller.scrollTop);
  };
  let traceArmed = false;
  const armTrace = () => {
    if (traceArmed) return;
    traceArmed = true;
    scroller.addEventListener('scroll', onTraceScroll, { passive: true });
  };
  const disarmTrace = () => {
    traceArmed = false;
    scroller.removeEventListener('scroll', onTraceScroll);
  };
  const glide = createThreadGlide(scroller, () => {
    disarmTrace();
    onGlideEnd?.();
  });
  glidesByScroller.set(scroller, glide);
  tracesByScroller.set(scroller, { trace, glide });
  // A GLIDE THAT `suspend` CANCELLED AND NO `play` TOOK UP (a new travel under GLIDE_MIN_PX, tokens that
  // do not resolve) is an END nobody delivers: no `finish` follows and `suspend` of a live glide
  // tells nothing. The rows are back at their place, so the trace's listener is disarmed and the pane
  // re-measures, as for every other end.
  const endUnreplayed = () => {
    disarmTrace();
    onGlideEnd?.();
  };
  // THE PANE'S OWN PIN, made as `follow()` makes its own (see {@link pinThreadToEnd}): transforms
  // off, the write to the layout's end, the glide put back on the same frame.
  pinsByScroller.set(scroller, (writer) => {
    const held = glide.suspend();
    scroller.scrollTop = scroller.scrollHeight;
    const placed = scroller.scrollTop;
    if (held) {
      Log.d('threadGrowth', `${writer} pinned the end mid-glide, ${Math.round(held.time)}ms in`);
      trace.recordWrite(writer, held.time, geometryOf(scroller));
      if (!glide.play(held.px, held.time)) endUnreplayed();
    }
    return placed;
  });
  /**
   * `added`: the elements this change inserted, whose bubbles wait out a glide that makes room for
   * them (`.motion-bubble-in[data-glide-entrance]`) - a bubble that arrives without one fades at once.
   */
  const follow = (cause: 'rows' | 'box', added: readonly Element[] = []) => {
    // A GLIDE IN FLIGHT IS TAKEN OFF THE ROWS BEFORE ANYTHING IS MEASURED (review of #3490, B1).
    // A transformed row counts in the scroller's scrollable overflow - measured in Chrome 2026-11-13:
    // `scrollHeight` grows by `max(0, offset - padding-bottom)` - so a pin to `scrollHeight` during
    // a glide went past the real bottom by the row's remaining offset and the rows rose too far,
    // then dropped back when the glide ended. With the transforms removed every number below is the
    // layout's; the glide is then put back exactly where it was drawn (same keyframes, same time
    // into it), so no frame shows the difference. The state is the running animation itself.
    const inGlide = glide.peek();
    const held = glide.suspend();
    const now = state();
    const scrollTopBefore = scroller.scrollTop;
    // The trace's numbers: read here (transforms cancelled, nothing written yet) and right after the
    // pin below - never with a transform on the rows, which would force a layout inside the window.
    const suspended = geometryOf(scroller);
    let pinned: Geometry | null = null;
    const currentReach = threadReach(scroller);
    const response = threadGrowthResponse({
      previousReach,
      currentReach,
      wasNearBottom: now.wasNearBottom,
      isLoadingOlder: now.isLoadingOlder,
      boxChanged: scroller.clientHeight !== previousClientHeight,
      isEntering: now.isEntering,
    });
    // How far the reader's top row moved in layout: what changed ABOVE what they see. No anchor (an
    // empty thread) moved nothing; one that left the document cannot say (`null`).
    const anchorMovedPx = !anchor
      ? 0
      : anchor.row.isConnected
        ? anchor.row.offsetTop - anchor.top
        : null;
    // THE ROW ANCHOR IS FOR A READER IN HISTORY ONLY: for one at the bottom, keeping the top row in
    // place is what scrolled the thread up when a `svh`-capped photo shrank under the keyboard.
    const shift =
      response === 'keep-row'
        ? anchorShift({
            previousTop: anchor?.top ?? null,
            currentTop: anchor?.row.isConnected ? anchor.row.offsetTop : null,
            isEntering: now.isEntering,
          })
        : 0;
    previousReach = currentReach;
    let travel = 0;
    if (response === 'follow-bottom') {
      scroller.scrollTop = scroller.scrollHeight;
      pinned = geometryOf(scroller);
      travel = appendGlidePx({
        cause,
        previousScrollTop: scrollTopBefore,
        currentScrollTop: scroller.scrollTop,
        previousClientHeight,
        currentClientHeight: scroller.clientHeight,
        isEntering: now.isEntering,
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
        anchorMovedPx,
      });
      if (cause === 'rows' && travel === 0 && anchorMovedPx !== 0 && !now.isEntering) {
        Log.d(
          'threadGrowth',
          `pinned without a glide: ${anchorMovedPx === null ? 'the top row left the thread' : `${Math.round(anchorMovedPx)}px changed above the viewport`}`
        );
      }
    }
    // A PREPEND - the window step or the store's page in `loadOlderGroups` - is kept HERE and only
    // here: nothing else writes `scrollTop` for it (2026-11-14).
    else if (shift !== 0) scroller.scrollTop += shift;
    if (response === 'follow-bottom' || shift !== 0) onPlaced?.(scroller.scrollTop);
    // TWO ARRIVALS INSIDE ONE GLIDE (S5): the new glide starts where the rows are DRAWN - what the
    // running one had left to travel, plus the new row - so nothing jumps. Otherwise the held glide
    // resumes as it was.
    //
    // AN ARRIVAL DURING A KEYBOARD RIDE (review of #3556, F8): the ride's transform and the glide's
    // would both be on the rows, and the later one replaces the other - the rows jumped from the
    // ride's offset to the glide's. The ride YIELDS: it is taken off the rows where it drew them
    // (`takeThreadRideOff`), and the glide starts from that offset plus the new row, as from a glide
    // of its own. A change that brings no arrival leaves the ride alone: its transform does not count
    // in the overflow measured above (it is inside the padding the keyboard's room opened, or above
    // the rows' place on a fall). The composer, a box of its own, rides on.
    if (travel > 0) {
      const ridden = takeThreadRideOff(scroller);
      if (ridden !== null) {
        Log.d(
          'threadGrowth',
          `arrival mid keyboard ride: the glide takes the rows from ${Math.round(ridden)}px`
        );
      }
      const playedPx = glideTravel(held, travel) + (ridden ?? 0);
      if (glide.play(playedPx)) {
        markGlideEntrance(added);
        trace.record(
          {
            cause,
            atMs: inGlide?.time ?? 0,
            suspended,
            pinned,
            held,
            response,
            travel,
            replayPx: playedPx,
            replayTime: 0,
          },
          inGlide === null
        );
        armTrace();
      } else if (held) endUnreplayed();
    } else if (held) {
      if (glide.play(held.px, held.time)) {
        trace.record(
          {
            cause,
            atMs: held.time,
            suspended,
            pinned,
            held,
            response,
            travel,
            replayPx: held.px,
            replayTime: held.time,
          },
          false
        );
      } else endUnreplayed();
    }
    previousClientHeight = scroller.clientHeight;
    captureAnchor();
  };

  const boxes = new ResizeObserver(() => follow('box'));
  boxes.observe(scroller);
  // EVERY CHILD'S BOX, because a medium decoding to its size is not a DOM mutation. An `<img>`
  // growing from 0 px when its GIF arrived changed no node and not the scroller's own box, so the
  // last message slid under the composer and nothing re-pinned it. `MediaFrame` reserves the size of
  // every new medium, which makes this rare - an old message taking its measured ratio once - and
  // this is what keeps that once from moving the reader. `observe` is idempotent, so the children
  // are re-enrolled on every mutation.
  const observeChildren = () => {
    for (const child of scroller.children) boxes.observe(child);
  };
  observeChildren();
  const mutations = new MutationObserver((records) => {
    // A child that left the pane is released, or the observer would hold every row ever rendered.
    for (const record of records) {
      if (record.target !== scroller) continue;
      for (const node of record.removedNodes) {
        if (node instanceof Element) boxes.unobserve(node);
      }
    }
    observeChildren();
    const added: Element[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) added.push(node);
    }
    follow('rows', added);
  });
  mutations.observe(scroller, { childList: true, subtree: true, characterData: true });
  if (composerBand) boxes.observe(composerBand);

  return () => {
    mutations.disconnect();
    boxes.disconnect();
    glide.stop();
    glidesByScroller.delete(scroller);
    tracesByScroller.delete(scroller);
    pinsByScroller.delete(scroller);
    disarmTrace();
    scroller.style.overflowAnchor = previousAnchoring;
  };
}

/** The glide of every thread `observeThreadGrowth` follows, for {@link takeThreadGlideOff}. */
const glidesByScroller = new WeakMap<Element, ThreadGlide>();

/** The pin of every thread `observeThreadGrowth` follows, for {@link pinThreadToEnd}. */
const pinsByScroller = new WeakMap<Element, (writer: string) => number>();

/**
 * Puts a thread's pane on its LAYOUT end and returns the `scrollTop` it landed on - the only way the
 * pane's own code writes its end (`ChatArea.scrollToBottom`), so every caller targets the same place.
 *
 * **A PIN TAKEN DURING A GLIDE MUST NOT READ THE GLIDE'S OVERFLOW** (iPhone 12, iOS 27, an image
 * arriving at a pinned DM, chat.md). A transformed row counts in `scrollHeight` by
 * `max(0, offset - padding-bottom)`, so a plain `scrollTop = scrollHeight` mid-glide wrote past the
 * real end; the next `follow()` pass took the transforms off, the engine clamped the pane back, and
 * the pane's measurement read that clamp as a fall below the last placed value and dropped the
 * reader's flag. So the glide is taken off first, exactly as `follow()` does, the end is written
 * against the layout, and the glide is played again from the same time and distance - no frame shows
 * the difference. A replay the engine refuses is the glide's end, told once as every end is. The
 * write is recorded in the glide's trace under `writer`.
 *
 * A thread no observer follows has no glide: the write is the whole of it.
 */
export function pinThreadToEnd(scroller: HTMLElement, writer: string): number {
  const pin = pinsByScroller.get(scroller);
  if (pin) return pin(writer);
  scroller.scrollTop = scroller.scrollHeight;
  return scroller.scrollTop;
}

/**
 * Takes a glide still in flight off a followed thread's rows, for good - the keyboard ride is about to
 * move the same rows (`keyboardRide.ts`), and two transforms on one row would fight. The ride reads the
 * rows' DRAWN top first, so it starts from where the reader saw them; the observer's next `follow`
 * finds no glide to resume. True when one was running.
 */
export function takeThreadGlideOff(scroller: Element): boolean {
  return glidesByScroller.get(scroller)?.takeOff() ?? false;
}

/** A keyboard ride on a followed thread's rows: the offset it started from and its animations. */
interface ThreadRide {
  /** Where the ride drew the rows at its start, relative to their place: + below, - above. */
  fromPx: number;
  animations: Animation[];
}

/** The keyboard ride running on each followed thread's rows, for {@link takeThreadRideOff}. */
const ridesByScroller = new WeakMap<Element, ThreadRide>();

/**
 * Tells a followed thread that a keyboard ride now moves its rows (`startKeyboardRide`), so an
 * arrival during it can take the rows on from where the ride drew them. A thread no observer follows
 * has no arrival to reconcile: nothing is kept.
 *
 * @param fromPx the ride's starting offset from the rows' place (its first keyframe's translation).
 */
export function attachThreadRide(scroller: Element, fromPx: number, animations: Animation[]): void {
  if (!glidesByScroller.has(scroller) || animations.length === 0) return;
  ridesByScroller.set(scroller, { fromPx, animations });
}

/**
 * Takes the keyboard ride off a thread's rows and says where it drew them, signed (`fromPx` times
 * what was left of its eased progress), or null when no ride is drawing them - none attached, or one
 * that ended or was cancelled (its timing has no progress then). The running animations ARE the
 * state, as for the glide.
 */
function takeThreadRideOff(scroller: Element): number | null {
  const ride = ridesByScroller.get(scroller);
  if (!ride) return null;
  ridesByScroller.delete(scroller);
  const progress = ride.animations[0].effect?.getComputedTiming().progress ?? null;
  for (const animation of ride.animations) animation.cancel();
  return progress === null ? null : ride.fromPx * (1 - progress);
}

/**
 * Reads a `--motion-*` duration token as milliseconds, or null if it is not a time. The token is
 * authored as `220ms` but Chromium (desktop and the Android WebView) answers the normalised `.22s`,
 * so both units and a leading-dot number are accepted; a parser keyed on the authored text alone
 * silently never played the glide there.
 */
export function motionMs(value: string): number | null {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === 's' ? Math.round(amount * 1000 * 1e6) / 1e6 : amount;
}

/** Where a glide taken off the rows had drawn them. */
export interface HeldGlide {
  /** The distance the glide was started with. */
  px: number;
  /** How far below their place the rows were drawn: `px` times what was left of the curve. */
  remaining: number;
  /** Milliseconds into the glide, to resume it on the same frame of its curve. */
  time: number;
}

/** The distance a new arrival glides from: the held glide's drawn offset, plus the new row. */
export function glideTravel(held: HeldGlide | null, travel: number): number {
  return (held?.remaining ?? 0) + travel;
}

/** A glide shorter than this is no glide: rounding between two reads of the same layout. */
const GLIDE_MIN_PX = 0.5;

/** The thread's glide, as the durable state `follow` reads: see {@link createThreadGlide}. */
export interface ThreadGlide {
  /**
   * Removes the glide's transforms so the layout can be measured, to be played again from where it
   * was (`play`); null when none was running - or when the one running was past its end with its
   * `finish` not delivered yet, which is that glide's END.
   */
  suspend(): HeldGlide | null;
  /**
   * The glide drawing the rows right now, without touching it: its distance and how far in it is
   * (null when none runs, or when it is past its end with its `finish` not delivered yet).
   */
  peek(): { px: number; time: number } | null;
  /** Ends a glide in flight for good (the keyboard ride takes the rows); true when one was running. */
  takeOff(): boolean;
  /**
   * Plays the rows from `px` below their place (above for a negative `px`, a keyboard fall's rows
   * taken on mid-ride) back to it, `time` ms in; false if nothing ran.
   */
  play(px: number, time?: number): boolean;
  /** Ends any glide at teardown: nothing is told, the pane is going. */
  stop(): void;
}

/**
 * The thread making room for an arrival as Messenger does (`appendGlidePx`): the rows, already at
 * their final place, are played from `px` lower back to it - a compositor transform on the motion
 * scale's `--motion-thread-glide` / `--motion-ease-in-out`, never a `scrollTop` animation. The
 * running animations ARE the state: `suspend` reads where they drew the rows from their own
 * computed timing (the eased progress) and cancels them; `play` starts them again. A glide that
 * ends clears itself on its `finish` event - no clock anywhere.
 *
 * **EVERY END OF A GLIDE THAT DREW THE ROWS OFF THEIR PLACE TELLS `onEnd`, ONCE** (review of #4095):
 * its `finish`, a suspend that finds it past its end before that `finish` was delivered, and a
 * `takeOff` for the keyboard ride. A suspend to measure and replay is not an end, nor the teardown.
 * The notice waits for the task that ended the glide to finish (a microtask, not a clock) and is
 * dropped when that task started another glide: what it measured is then that glide's, whose own
 * end tells it again.
 */
export function createThreadGlide(scroller: HTMLElement, onEnd?: () => void): ThreadGlide {
  let running: { px: number; animations: Animation[] } | null = null;

  const ended = () => {
    queueMicrotask(() => {
      if (running === null) onEnd?.();
    });
  };

  /** Cancels the running glide; `held` is where it drew the rows, `null` when past its end. */
  const cancel = (): { held: HeldGlide | null } | null => {
    const current = running;
    if (!current) return null;
    running = null;
    const first = current.animations[0];
    const progress = first.effect?.getComputedTiming().progress ?? null;
    const time = Number(first.currentTime ?? 0);
    for (const animation of current.animations) animation.cancel();
    // A null progress is a glide past its end whose `finish` has not been delivered yet: nothing is
    // left to draw, and nothing to resume.
    if (progress === null) return { held: null };
    return { held: { px: current.px, remaining: current.px * (1 - progress), time } };
  };

  const suspend = (): HeldGlide | null => {
    const cancelled = cancel();
    if (cancelled && cancelled.held === null) ended();
    return cancelled?.held ?? null;
  };

  const peek = (): { px: number; time: number } | null => {
    if (!running) return null;
    const first = running.animations[0];
    if ((first.effect?.getComputedTiming().progress ?? null) === null) return null;
    return { px: running.px, time: Number(first.currentTime ?? 0) };
  };

  const takeOff = (): boolean => {
    const cancelled = cancel();
    if (cancelled) ended();
    return cancelled?.held != null;
  };

  const play = (px: number, time = 0): boolean => {
    if (Math.abs(px) < GLIDE_MIN_PX) return false;
    const root = getComputedStyle(document.documentElement);
    const duration = motionMs(root.getPropertyValue('--motion-thread-glide'));
    const easing = root.getPropertyValue('--motion-ease-in-out').trim();
    if (duration === null || !easing) {
      Log.w('threadGrowth', `glide of ${px}px skipped: the motion tokens did not resolve`);
      return false;
    }
    const animations: Animation[] = [];
    for (const child of scroller.children) {
      if (!(child instanceof HTMLElement) || typeof child.animate !== 'function') continue;
      const animation = child.animate(
        [{ transform: `translateY(${px}px)` }, { transform: 'none' }],
        { duration, easing }
      );
      if (time > 0) animation.currentTime = time;
      animations.push(animation);
    }
    if (animations.length === 0) return false;
    const run = { px, animations };
    running = run;
    animations[0].addEventListener('finish', () => {
      // Only the glide still drawing the rows ends them: one cancelled to be replaced is not an end.
      if (running !== run) return;
      running = null;
      ended();
    });
    if (time === 0) {
      Log.d('threadGrowth', `arrival: thread glides ${Math.round(px)}px over ${duration}ms`);
    }
    return true;
  };

  return { suspend, peek, takeOff, play, stop: () => void cancel() };
}

/**
 * Marks the bubbles among `added` as waiting out the glide that makes room for them
 * (`.motion-bubble-in[data-glide-entrance]`, app.css). Set in the same task as their mount, before
 * any frame, so the plain fade they started with is never seen.
 */
function markGlideEntrance(added: readonly Element[]): void {
  for (const node of added) {
    if (node.matches('.motion-bubble-in')) node.setAttribute('data-glide-entrance', '');
    for (const bubble of node.querySelectorAll('.motion-bubble-in')) {
      bubble.setAttribute('data-glide-entrance', '');
    }
  }
}
