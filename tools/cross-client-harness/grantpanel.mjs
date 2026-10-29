/**
 * THE SALON ACCESS PANEL'S OWN "ADD" BUTTON, FOUND FROM ITS SEARCH FIELD - a page-side snippet.
 *
 * A member's join-request banner carries an "Ajouter" too, and a page-wide `text=` click approved a
 * device's join instead of granting the salon (KICK-COMMIT on `1.5.1-alpha.7`, 2026-10-29: the grant
 * never ran, and W1 logged `approved by this member` at that instant). So the climb from the field
 * looks for ONE thing, the panel's "add a user" SECTION - the nearest ancestor holding the section's
 * own label - and the button is looked for INSIDE it alone. A field outside the section, or a
 * section with no such button, is a NAMED failure, never a climb on to `body` where the banner's
 * button would be found and marked instead.
 *
 * A plain string, so `archive/grantpanel-selftest.mjs` runs the snippet that reads the live page,
 * unchanged, against a fixture tree. Pure: no rig, no browser, no `names.mjs`.
 */

/** The attribute the snippet puts on the button it found: what the caller waits on and clicks. */
export const GRANT_ADD_MARK = 'data-harness-grant-add';

/**
 * Page-side: marks the panel's add button and answers whether it is enabled; throws, named, when the
 * field is missing or its section holds no add button.
 *
 * The section label is compared on `textContent`: it is drawn `uppercase`, and `innerText` follows
 * the CSS transform.
 *
 * @param {{placeholder: string, add: string, section: string}} captions the field's placeholder, the
 *   button's caption and the section label's caption, all read from `fr.json`
 * @returns {string} an expression evaluating to a boolean
 */
export const markGrantAddJs = ({ placeholder, add, section }) => `(function () {
  var input = document.querySelector(${JSON.stringify(`input[placeholder=${JSON.stringify(placeholder)}]`)});
  if (!input) throw new Error('grant-panel-no-field: no field ' + ${JSON.stringify(placeholder)});
  var sectionEl = null;
  for (var el = input.parentElement; el && !sectionEl; el = el.parentElement) {
    var owns = [].slice.call(el.querySelectorAll('p')).some(function (x) {
      return (x.textContent || '').trim() === ${JSON.stringify(section)};
    });
    if (owns) sectionEl = el;
  }
  if (!sectionEl) throw new Error('grant-panel-no-section: the field is not inside the section ' + ${JSON.stringify(section)});
  var b = [].slice.call(sectionEl.querySelectorAll('button')).filter(function (x) {
    return (x.innerText || '').trim() === ${JSON.stringify(add)};
  })[0];
  if (!b) throw new Error('grant-panel-no-add-button: the section ' + ${JSON.stringify(section)} + ' holds no ' + ${JSON.stringify(add)} + ' button');
  [].slice.call(document.querySelectorAll('[${GRANT_ADD_MARK}]')).forEach(function (x) {
    x.removeAttribute('${GRANT_ADD_MARK}');
  });
  b.setAttribute('${GRANT_ADD_MARK}', '1');
  return !b.disabled;
})()`;
