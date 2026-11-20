/**
 * The identity provider's sign-in stages as the rig sees them: which one is on screen, and what answers it.
 *
 * Shared by `login.mjs` (which drives them over CDP, on the web and in the phone's Custom Tab) and
 * `archive/idpform-selftest.mjs` (which pins the classification without a browser). Every function
 * that runs IN the page is written as a plain function and shipped with `.toString()`, so the copy the
 * page runs and the copy the test exercises are the same source.
 *
 * THE TERMS STAGE (`miconnect-authorization`, blueprint `45-consent.yaml`) is the reason this module
 * exists. Once that blueprint is applied, every account whose `attributes.cgu_version` differs from the
 * current version is shown ONE page after the password: a static notice, a required checkbox
 * `cgu_accept`, and the submit button. A rig that does not know that page reads it as "no credential
 * form" and every harness login stalls on it, which is the second of the three conditions the backlog
 * sets before the hold on that blueprint is lifted
 * (docs/wiki/backlog.md, "The MiConnect terms stage reaches production").
 */

/**
 * Resolves a selector THROUGH SHADOW ROOTS, preferring a VISIBLE match.
 *
 * Authentik's flow executor renders its stages in web components, so `document.querySelector` sees
 * none of its fields. It also ships a hidden autofill trio (`username`, `password`, `code`) on every
 * stage, so the first match of `input[type=password]` can be an invisible field while the
 * identification stage is on screen - typing into it submits nothing. Hence: visible matches only.
 *
 * Runs in the page; `root` is `document` there and a fake in the self-test.
 * @param {string} sel
 * @param {{ querySelectorAll(sel: string): ArrayLike<any> }} root
 * @returns {any} the first visible match, or null
 */
export function deepVisible(sel, root) {
  const hits = [];
  const walk = (r) => {
    hits.push(...Array.from(r.querySelectorAll(sel)));
    for (const n of Array.from(r.querySelectorAll('*'))) if (n.shadowRoot) walk(n.shadowRoot);
  };
  walk(root);
  const shown = hits.filter((e) => {
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  });
  return shown[0] || null;
}

/**
 * Resolves a selector THROUGH SHADOW ROOTS whether or not the match is laid out - the same walk as
 * {@link deepVisible}, without its size filter.
 *
 * The terms checkbox is the one control the classifier must find even when the page styles the
 * native input out of layout (a custom-drawn box with a zero-size input, which is how a design
 * system restyles a checkbox). Safe for THAT field only because `cgu_accept` exists on no other
 * stage; the autofill trio is on every stage, which is why the other lookups stay visible-only.
 * @param {string} sel
 * @param {{ querySelectorAll(sel: string): ArrayLike<any> }} root
 * @returns {any} the first match, or null
 */
export function deepAny(sel, root) {
  const walk = (r) => {
    const own = Array.from(r.querySelectorAll(sel));
    if (own.length) return own[0];
    for (const n of Array.from(r.querySelectorAll('*'))) {
      if (n.shadowRoot) {
        const hit = walk(n.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

/**
 * Which credential stage is on screen, named by what it renders, or null between stages.
 *
 * `cas` is the school's server-rendered page. The service-account flow is up to THREE stages on the
 * same URL: the identifier, the password, then - for an account that has not accepted the current
 * terms - the terms page. The terms page is tested FIRST of the authentik three because it is the
 * only one carrying `cgu_accept`; the hidden autofill trio is on it too, and a visible-only lookup is
 * what keeps that from reading as a password stage. THE TERMS BOX ITSELF IS FOUND WITH `any`, laid
 * out or not: a page that restyles its checkbox must not read as "no stage", which is what stalled
 * every sign-in of the 2026-11-20 reading ("the authentik-password stage never gave way").
 *
 * Runs in the page.
 * @param {(sel: string) => any} q a visible-match lookup bound to the page
 * @param {{ querySelector(sel: string): any }} doc
 * @param {(sel: string) => any} [any] a lookup that ignores layout; defaults to `q`
 * @returns {'cas' | 'authentik-terms' | 'authentik-uid' | 'authentik-password' | null}
 */
export function classifyIdpForm(q, doc, any = q) {
  if (doc.querySelector('#username')) return 'cas';
  if (any('input[name=cgu_accept]')) return 'authentik-terms';
  if (q('input[name=uidField]')) return 'authentik-uid';
  if (q('input[type=password]')) return 'authentik-password';
  return null;
}

/** The page-side lookup, as an expression taking a selector: `${DEEP}(sel)`. */
export const DEEP = `(function (sel) { return (${deepVisible.toString()})(sel, document); })`;

/** The page-side layout-blind lookup, as an expression taking a selector: `${DEEP_ANY}(sel)`. */
export const DEEP_ANY = `(function (sel) { return (${deepAny.toString()})(sel, document); })`;

/** The page-side classification, as an expression evaluating to the stage name or null. */
export const FORM_SHAPE = `(${classifyIdpForm.toString()})(${DEEP}, document, ${DEEP_ANY})`;

/**
 * What an UNCLASSIFIED page is made of, as an expression for the page: tag, type and name of its
 * visible controls and the label of its buttons, NEVER a value (a password field is reported as a
 * password field and nothing more). It is what a stalled login throws, so the next unknown stage
 * names itself instead of costing a night.
 */
export const DESCRIBE_STAGE = `(function (deep) {
  var out = [];
  var walk = function (r) {
    Array.prototype.forEach.call(r.querySelectorAll('input,button,select,textarea,a[href]'), function (e) {
      var b = e.getBoundingClientRect();
      var shown = b.width > 0 && b.height > 0;
      var tag = e.tagName.toLowerCase();
      var label = tag === 'button' || tag === 'a' ? ' "' + (e.textContent || '').trim().slice(0, 40) + '"' : '';
      out.push((shown ? '' : '~') + tag + (e.type ? '[' + e.type + ']' : '') + (e.name ? '#' + e.name : '') + label);
    });
    Array.prototype.forEach.call(r.querySelectorAll('*'), function (n) { if (n.shadowRoot) walk(n.shadowRoot); });
  };
  walk(document);
  return out.join(' ');
})()`;

/**
 * What each stage wants typed (`fields`), ticked (`ticks`) and pressed (`submit`).
 *
 * The terms stage types nothing: it is ONE required tick and the submit. Ticking it is the rig's
 * consent on behalf of a TEST account, which is what that account exists for; a real person's
 * account is never driven by this file.
 * @param {{ username: string, password: string }} creds
 */
export function stageTable(creds) {
  return {
    cas: { fields: [['#username', creds.username], ['#password', creds.password]], ticks: [], submit: '#submitBtn' },
    'authentik-uid': { fields: [['input[name=uidField]', creds.username]], ticks: [], submit: 'button[type=submit]' },
    'authentik-password': { fields: [['input[type=password]', creds.password]], ticks: [], submit: 'button[type=submit]' },
    'authentik-terms': { fields: [], ticks: ['input[name=cgu_accept]'], submit: 'button[type=submit]' },
  };
}

/**
 * Ticks a checkbox and reports the state it ENDS in, as an expression for the page.
 *
 * A click, not `checked = true`: the prompt stage is a Lit component that reads its inputs from the
 * events a real toggle fires, so a silently assigned property may never reach the POST. Already ticked
 * is left alone (a second click would UNtick it). The answer is read back, never assumed.
 * @param {string} selector
 * @returns {string} evaluates to 'ticked', 'not-ticked' or 'missing'
 */
export function tickScript(selector) {
  return `(function () {
    const e = ${DEEP_ANY}(${JSON.stringify(selector)});
    if (!e) return 'missing';
    if (!e.checked) e.click();
    return e.checked ? 'ticked' : 'not-ticked';
  })()`;
}
