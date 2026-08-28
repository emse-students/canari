/**
 * THE ONE EXPRESSION THAT ANSWERS "what is covering the screen right now" - page source, kept PURE.
 *
 * IT LIVED IN `chat.mjs`, WHICH IMPORTS `names.mjs`, WHICH IS GITIGNORED because it holds real
 * display names and this repository is PUBLIC. So the readiness probe - which interpolates this -
 * could not be tested by anything in the CI gate: `gate-selftest.mjs` refused it, correctly, three
 * modules down its import graph. A predicate that cannot be imported by a test is a predicate with no
 * test, and this one has already been wrong twice on the shape it exists to catch.
 *
 * `chat.mjs` RE-EXPORTS IT, so no caller moved and there is still exactly one definition.
 */

/**
 * WHAT IS COVERING THE SCREEN RIGHT NOW - the two shapes, found STRUCTURALLY.
 *
 * Both are read from geometry and ARIA rather than from a class or a caption, because both of those
 * drift: the classes are Tailwind utilities rewritten whenever the design is touched, and the
 * captions are Paraglide strings that differ between `fr` and `en`. A selector built on either would
 * pass here and silently match nothing on the day it mattered.
 *
 *   - A DIALOG is `[role=dialog][aria-modal=true]` - what `Modal.svelte`, `ConfirmDialog.svelte` and
 *     `FullScreenViewer.svelte` all render, and all three close on Escape.
 *   - A BACKDROP is a visible `button` covering nearly the whole viewport. That is the universal
 *     shape of a dismiss-on-outside-click sheet, and it is the ONLY handle on the one that matters
 *     most here: `MessageMobileActions.svelte` has no role, no `aria-modal` and NO Escape handler,
 *     so a dialog-only sweep would report the screen clear while a mobile action sheet still owns
 *     every click. It is `md:hidden`, which means A1 and a narrow browser, and it is exactly what a
 *     long-press check leaves behind when it dies.
 */
export const OVERLAYS = `(function () {
  var out = [];
  // ITS OWN transition, not an ancestor's. IS_MOVING_FN walks up the tree because its question is
  // "can this be clicked yet", which any moving ancestor answers; the question HERE is narrower -
  // whether THIS element's own opacity is still travelling - and widening it would let any animation
  // anywhere above a genuinely hidden dialog present it as debris to be cleared. Measured on the
  // real dialog: the fade is on the element itself, and an idle page holds no mounted dialog at all.
  var moving = function (e) {
    if (!e || typeof e.getAnimations !== 'function') return false;
    var as = e.getAnimations();
    for (var i = 0; i < as.length; i++) {
      if (as[i].playState === 'running' || as[i].playState === 'pending') return true;
    }
    return false;
  };
  var vis = function (e) {
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    var s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none') return null;
    // OPACITY IS A MOVING QUANTITY DURING A FADE, AND THIS USED TO READ IT AS A STATE. A dialog
    // renders at opacity 0 for the first frames of its entry transition, so a caller that arrived
    // inside that window was told the screen was CLEAN while a 894x631 modal was opening on top of
    // it - measured on 2026-08-20: op "0" on one sample, "1" on the next, 300ms apart.
    //
    // That is not a cosmetic miss. clearOverlays is the rig's only isolation guarantee and
    // enterCommunities calls it at the START of every runner, so the false negative hands the next
    // check a covered screen; it then dies several steps downstream on "no stable element" for an
    // element that is plainly in the DOM, which is a whole evening of diagnosis away from the cause.
    //
    // Not fixed with a wait: a sleep would only make the sample likelier to land after the fade,
    // which is the same race with better odds. The overlap is that a transitioning value was read as
    // a settled one, so the question asked is whether it has settled. An element that is fading OUT
    // also counts as present here, deliberately - pressing Escape at a dialog already closing is a
    // no-op, while missing one that is opening is the fault above.
    if (s.opacity === '0' && !moving(e)) return null;
    return r;
  };
  [].slice.call(document.querySelectorAll('[role=dialog][aria-modal=true]')).forEach(function (d) {
    if (vis(d)) out.push({ kind: 'dialog', label: (d.getAttribute('aria-label') || '').slice(0, 60) });
  });
  var area = window.innerWidth * window.innerHeight;
  [].slice.call(document.querySelectorAll('button')).forEach(function (b) {
    var r = vis(b);
    if (r && r.width * r.height >= 0.8 * area) {
      out.push({ kind: 'backdrop', label: (b.getAttribute('aria-label') || '').slice(0, 60) });
    }
  });
  return JSON.stringify(out);
})()`;
