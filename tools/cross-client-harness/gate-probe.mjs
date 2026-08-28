/**
 * The ONE expression that answers "is the encryption PIN gate on screen".
 *
 * IT HAD THREE COPIES, AND THE LOOSEST OF THEM DECIDED. `pin.mjs`, `pingate.mjs` and `state.mjs`
 * each carried their own, all three keyed partly on `document.body.innerText` containing
 * "PIN de chiffrement" - and `/settings` NAMES the gate in its own security section
 * (`profile_pin_heading`, "Code PIN de chiffrement", which contains that substring). So a client
 * parked on `/settings` read LOCKED while being perfectly unlocked. Measured 2026-08-28 on W1:
 * `pin.mjs` spent its whole 25 s deadline and reported "no unlock modal", `state.mjs` printed
 * `LOCKED`, and `pingate.settle()` - whose `gate` branch is tested BEFORE `mounted` - would have
 * returned LOCKED to comm17, comm18, comm22 and tab3b, none of which produces a verdict when the
 * gate cannot be passed.
 *
 * A GATE IS A MODAL, NOT A PHRASE. The prompt is `PinModal.svelte` rendered through
 * `shared/Modal.svelte`, which carries `role="dialog"` and `aria-label={title}` - so the gate is
 * identifiable EXACTLY, by the label of a dialog, instead of approximately by any text anywhere on
 * the page. A page that merely talks about the PIN has no such dialog.
 *
 * The three conditions are kept because they fail independently: the id covers the desktop input,
 * the erase glyph covers the mobile keypad (which has no `#encryption-pin` at all), and the dialog
 * label covers both shapes and survives either of the other two being restyled.
 *
 * EMBEDDED VERBATIM, AND RAW. This is page source, interpolated into a caller's own template with
 * `${GATE_EXPR}` - interpolation does not re-process escapes, so what is written here is what the
 * client parses, and the double-escaping the three old copies needed is gone. `String.raw` is what
 * makes that true of `⌫` as well: without it Node resolves the escape here and the page is
 * handed a glyph instead of the source that produces one. `${...}` still interpolates.
 */

/** The gate's title, as `Modal`'s `aria-label` spells it - `auth_pin_title`, and the setup variant which contains it. */
const DIALOG_LABEL = 'PIN de chiffrement';

/** A JS expression, evaluating in the page to `true` when the PIN prompt is up. */
export const GATE_EXPR = String.raw`(function () {
  var field = !!document.querySelector('#encryption-pin');
  var keypad = [].some.call(document.querySelectorAll('button'), function (b) {
    return b.innerText.trim() === '\u232b';
  });
  var dialog = [].some.call(document.querySelectorAll('[role=dialog]'), function (d) {
    return (d.getAttribute('aria-label') || '').indexOf('${DIALOG_LABEL}') !== -1;
  });
  return field || keypad || dialog;
})()`;
