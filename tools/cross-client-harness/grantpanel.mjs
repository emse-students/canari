/**
 * THE SALON ACCESS PANEL'S OWN "ADD" BUTTON, FOUND FROM ITS SEARCH FIELD - a page-side snippet.
 *
 * A member's join-request banner carries an "Ajouter" too, and a page-wide `text=` click approved a
 * device's join instead of granting the salon (KICK-COMMIT on `1.5.1-alpha.7`, 2026-10-29: the grant
 * never ran, and W1 logged `approved by this member` at that instant). So the climb from the field
 * looks for ONE thing, the panel's "add a user" SECTION - the nearest ancestor holding the section's
 * own label - and the button is looked for INSIDE it alone. A field outside the section, or a
 * section with no such button, is a NAMED state, never a climb on to `body` where the banner's
 * button would be found and marked instead.
 *
 * A plain string, so `archive/grantpanel-selftest.mjs` runs the snippet that reads the live page,
 * unchanged, against a fixture tree. Pure: no rig, no browser, no `names.mjs`.
 */

/** The attribute the snippet puts on the button it found: what the caller waits on and clicks. */
export const GRANT_ADD_MARK = 'data-harness-grant-add';

/**
 * The states the snippet answers. Only `enabled` lets the caller click; `disabled` is the button
 * found before a suggestion was chosen. The three `grant-panel-*` states are what a caller that
 * stops waiting NAMES in its error.
 */
export const GRANT_PANEL_STATES = [
  'enabled',
  'disabled',
  'grant-panel-no-field',
  'grant-panel-no-section',
  'grant-panel-no-add-button',
];

/**
 * Page-side: marks the panel's add button and answers ONE state of {@link GRANT_PANEL_STATES}.
 *
 * IT ANSWERS, IT NEVER THROWS: the panel re-renders while the grant is chosen, and the field is
 * absent for a moment between two of its states (SALON-REVOKE-COMMIT on `1.5.1-alpha.8`,
 * 2026-10-29: a snippet that threw on the first poll ended the row in `ERROR` before the field came
 * back). The caller polls, and names the last state when it stops (`awaitGrantAdd` in `comm.mjs`).
 * Whatever the state, nothing outside the section is ever marked.
 *
 * The section label is compared on `textContent`: it is drawn `uppercase`, and `innerText` follows
 * the CSS transform.
 *
 * @param {{placeholder: string, add: string, section: string}} captions the field's placeholder, the
 *   button's caption and the section label's caption, all read from `fr.json`
 * @returns {string} an expression evaluating to one of {@link GRANT_PANEL_STATES}
 */
export const markGrantAddJs = ({ placeholder, add, section }) => `(function () {
  var input = document.querySelector(${JSON.stringify(`input[placeholder=${JSON.stringify(placeholder)}]`)});
  if (!input) return 'grant-panel-no-field';
  var sectionEl = null;
  for (var el = input.parentElement; el && !sectionEl; el = el.parentElement) {
    var owns = [].slice.call(el.querySelectorAll('p')).some(function (x) {
      return (x.textContent || '').trim() === ${JSON.stringify(section)};
    });
    if (owns) sectionEl = el;
  }
  if (!sectionEl) return 'grant-panel-no-section';
  var b = [].slice.call(sectionEl.querySelectorAll('button')).filter(function (x) {
    return (x.innerText || '').trim() === ${JSON.stringify(add)};
  })[0];
  if (!b) return 'grant-panel-no-add-button';
  [].slice.call(document.querySelectorAll('[${GRANT_ADD_MARK}]')).forEach(function (x) {
    x.removeAttribute('${GRANT_ADD_MARK}');
  });
  b.setAttribute('${GRANT_ADD_MARK}', '1');
  return b.disabled ? 'disabled' : 'enabled';
})()`;

/**
 * Polls `read()` (one evaluation of {@link markGrantAddJs}) until it answers `enabled`, and throws
 * an error NAMING the last state when `timeoutMs` passes - so a panel without its button still
 * fails by name, only no longer on a transient re-render.
 *
 * @param {() => Promise<string>} read evaluates the snippet once
 * @param {number} timeoutMs how long the panel may take to offer an enabled button
 * @param {(ms: number) => Promise<void>} [sleep] the pause between polls (a test passes its own)
 * @returns {Promise<void>}
 */
export async function awaitGrantAdd(
  read,
  timeoutMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
) {
  const t0 = Date.now();
  let last = null;
  for (let polls = 0; polls === 0 || Date.now() - t0 < timeoutMs; polls++) {
    last = await read();
    if (!GRANT_PANEL_STATES.includes(last))
      throw new Error(`grant-panel: the snippet answered ${JSON.stringify(last)}`);
    if (last === 'enabled') return;
    await sleep(60);
  }
  throw new Error(
    last === 'disabled'
      ? `grant-panel-add-disabled: the add button never enabled in ${timeoutMs} ms`
      : `${last}: after ${timeoutMs} ms`
  );
}
