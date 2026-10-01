/**
 * THE IN-APP PICKER AS THE RIG SEES IT: how to find its trigger, read what its open list offers, and
 * decide which option a visible label names - all pure, none of it touching a browser.
 *
 * WHY IT IS A MODULE OF STRINGS AND ONE DECISION. `Picker.svelte` (#1227) replaced the native
 * `<select>` and with it the assumption `chooseOption` was written on: a select has `.value` and
 * `.options`, so the rig assigned a value and dispatched `change`. The Picker has neither. Its
 * options are `<button role="option">` elements with NO value attribute - the value is a JS closure
 * - so the only thing a person (or the rig) can name an option by is the label it DRAWS. That label
 * is a Paraglide message, so callers read it from `fr.json` through `caption`, never spell it.
 *
 * It is split from `comm.mjs` for the reason `messages.mjs` is: `comm.mjs` reaches `chat.mjs` and
 * the out-of-tree `names.mjs`, so a CI gate could not import it on a fresh checkout. The page-side
 * snippets are plain strings precisely so `archive/picker-selftest.mjs` can run them, unchanged,
 * against fixture markup.
 *
 * The markup this reads (see `frontend/src/lib/components/ui/Picker.svelte`):
 *   trigger  `<button aria-haspopup="listbox" aria-label="<label> - <selected label>">`
 *   list     `<div role="listbox" aria-label="<label>">` portalled by `FloatingSurface`
 *   option   `<button role="option" aria-selected disabled?>` whose FIRST text line is the label
 *            (a muted description may follow on a second line).
 */

/** Every Picker trigger on the page, whatever it is styled as. */
export const PICKER_TRIGGER = 'button[aria-haspopup="listbox"]';

/** The options of the picker that is OPEN. A closed Picker renders no list at all. */
const OPEN_OPTIONS = '[role="listbox"] [role="option"]';

/** Joined with the picker's label to form the trigger's accessible name; see `Picker.svelte`. */
const NAME_SEPARATOR = ' - ';

/**
 * Selector for the trigger of the picker NAMED `pickerLabel` (its `label` prop, a Paraglide message).
 * Several pickers can share a label (every member's role), so callers scope it with a row selector.
 */
export function triggerByLabel(pickerLabel) {
  return `${PICKER_TRIGGER}[aria-label^=${JSON.stringify(pickerLabel + NAME_SEPARATOR)}]`;
}

/**
 * The label a trigger currently shows, out of its `aria-label`; null when it is not that picker's.
 *
 * Read from the accessible name rather than the trigger's text because a custom trigger snippet may
 * draw anything (an avatar and a name), while the accessible name is always `<label> - <selected>`.
 */
export function currentLabelOf(ariaLabel, pickerLabel) {
  const prefix = pickerLabel + NAME_SEPARATOR;
  return typeof ariaLabel === 'string' && ariaLabel.startsWith(prefix)
    ? ariaLabel.slice(prefix.length)
    : null;
}

/**
 * Page-side: whether the options of an open picker are on screen yet. An expression, for `until`.
 */
export const PICKER_IS_OPEN = `document.querySelectorAll(${JSON.stringify(OPEN_OPTIONS)}).length > 0`;

/**
 * Page-side: what the open picker offers, as a JSON string of `[{ label, selected, disabled }]`.
 * The label is the option's FIRST text line, so a description under it never becomes part of it.
 */
export const PICKER_OPTIONS_JS = `(function () {
  var NL = String.fromCharCode(10);
  var els = [].slice.call(document.querySelectorAll(${JSON.stringify(OPEN_OPTIONS)}));
  return JSON.stringify(els.map(function (el) {
    return {
      label: ((el.innerText || '').split(NL)[0] || '').trim(),
      selected: el.getAttribute('aria-selected') === 'true',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    };
  }));
})()`;

/** The attribute that marks the option about to be clicked, so `realClick` can hit-test it. */
export const OPTION_MARK = 'data-harness-option';

/**
 * Page-side: marks the open picker's option number `index` (and unmarks any other), so the click
 * that follows goes through `realClick`, which needs a selector. Returns `'marked'` or `'gone'`.
 */
export const markOptionJs = (index) => `(function () {
  var els = [].slice.call(document.querySelectorAll(${JSON.stringify(OPEN_OPTIONS)}));
  els.forEach(function (el) { el.removeAttribute(${JSON.stringify(OPTION_MARK)}); });
  var el = els[${Number(index)}];
  if (!el) return 'gone';
  el.setAttribute(${JSON.stringify(OPTION_MARK)}, '');
  return 'marked';
})()`;

/** Page-side: removes the mark, whatever happened in between. */
export const UNMARK_OPTION_JS = `(function () {
  [].slice.call(document.querySelectorAll('[${OPTION_MARK}]')).forEach(function (el) {
    el.removeAttribute(${JSON.stringify(OPTION_MARK)});
  });
  return 'ok';
})()`;

/**
 * Decides which of an open picker's options a visible label names.
 *
 * EXACT MATCH ON THE TRIMMED LABEL, because two options can share a prefix ("Admins uniquement" and
 * "Admins et moderateurs uniquement"). Every failure carries a precise REASON, as a value, so the
 * caller can say what the screen offered instead of "no option":
 *   - `no-options`         the list is empty: the picker did not open, or was given nothing
 *   - `no-option`          nothing matches; the reason lists what WAS offered
 *   - `ambiguous`          more than one option carries that label, so a click would be a guess
 *   - `disabled-option`    the option exists and is not choosable
 *
 * @param {{label: string, selected: boolean, disabled: boolean}[]} options
 * @param {string} wanted the label to pick
 * @returns {{ok: true, index: number, alreadySelected: boolean} | {ok: false, reason: string}}
 */
export function decidePickerChoice(options, wanted) {
  if (options.length === 0) return { ok: false, reason: 'no-options' };
  const target = String(wanted).trim();
  const hits = options.flatMap((o, i) => (o.label === target ? [i] : []));
  if (hits.length === 0) {
    const offered = options.map((o) => JSON.stringify(o.label)).join(', ');
    return { ok: false, reason: `no-option: ${JSON.stringify(target)} not among ${offered}` };
  }
  if (hits.length > 1) {
    return { ok: false, reason: `ambiguous: ${hits.length} options are labelled ${JSON.stringify(target)}` };
  }
  const option = options[hits[0]];
  if (option.disabled) {
    return { ok: false, reason: `disabled-option: ${JSON.stringify(target)} is shown but not choosable` };
  }
  return { ok: true, index: hits[0], alreadySelected: option.selected };
}
