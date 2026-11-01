/**
 * THE GRANT CLICKS THE PANEL'S OWN "ADD", NEVER A JOIN-REQUEST BANNER'S (`grantpanel.mjs`).
 *
 *   bun archive/grantpanel-selftest.mjs
 *
 * The snippet that reads the live page is run HERE, unchanged, against a fixture tree shaped like
 * `ChannelSettingsPanel.svelte`'s "add a user" section next to a banner carrying its own "Ajouter".
 * The captions are READ FROM `fr.json` through `caption`, never spelt.
 *
 * A micro DOM stands in for a browser (a fresh CI checkout has no frontend dependencies). It
 * implements only what the snippet uses - `querySelector` by placeholder, `querySelectorAll` for
 * `button`, `p` and the mark, `parentElement`, `innerText`, `textContent`, `disabled` and the
 * attribute calls - so a snippet that grows past that fails here, loudly.
 */
import { GRANT_ADD_MARK, awaitGrantAdd, markGrantAddJs } from '../grantpanel.mjs';
import { caption } from '../messages.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const PLACEHOLDER = caption('chat_search_user_placeholder');
const ADD = caption('common_add_button');
const SECTION = caption('chat_channel_add_user_label');
const JS = markGrantAddJs({ placeholder: PLACEHOLDER, add: ADD, section: SECTION });

/** An element: `tag`, attributes, its own text and children; `parentElement` is wired by `doc`. */
const h = (tag, attrs = {}, ...children) => ({
  tag,
  attrs: { ...attrs },
  text: children.filter((c) => typeof c === 'string').join(''),
  children: children.filter((c) => typeof c !== 'string'),
  parentElement: null,
});

function doc(root) {
  const all = [];
  const walk = (el, parent) => {
    el.parentElement = parent;
    all.push(el);
    el.children.forEach((c) => walk(c, el));
  };
  walk(root, null);
  const below = (el) => el.children.flatMap((c) => [c, ...below(c)]);
  const textOf = (el) => el.text + el.children.map(textOf).join('');
  const match = (sel) => {
    if (sel === 'button' || sel === 'p') return (el) => el.tag === sel;
    if (sel === `[${GRANT_ADD_MARK}]`) return (el) => GRANT_ADD_MARK in el.attrs;
    throw new Error(`micro DOM: unsupported selector ${sel}`);
  };
  for (const el of all) {
    Object.defineProperties(el, {
      innerText: { get: () => textOf(el) },
      textContent: { get: () => textOf(el) },
      disabled: { get: () => 'disabled' in el.attrs },
    });
    el.querySelectorAll = (sel) => below(el).filter(match(sel));
    el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null);
    el.setAttribute = (n, v) => void (el.attrs[n] = String(v));
    el.removeAttribute = (n) => void delete el.attrs[n];
  }
  return {
    querySelector: (sel) => {
      if (sel !== `input[placeholder=${JSON.stringify(PLACEHOLDER)}]`)
        throw new Error(`micro DOM: unsupported selector ${sel}`);
      return all.find((el) => el.tag === 'input' && el.attrs.placeholder === PLACEHOLDER) ?? null;
    },
    querySelectorAll: (sel) => all.filter(match(sel)),
  };
}

const run = (document) => new Function('document', `return ${JS};`)(document);

/** The banner and the panel, side by side under `body`; `panelButton` false drops the panel's button. */
function page({ panelButton = true, disabled = false, staleOnBanner = false, field = true } = {}) {
  const banner = h('button', staleOnBanner ? { [GRANT_ADD_MARK]: '1' } : {}, ADD);
  const add = panelButton ? h('button', disabled ? { disabled: '' } : {}, ADD) : null;
  const row = h(
    'div',
    {},
    h('div', {}, field ? h('input', { placeholder: PLACEHOLDER }) : h('span', {})),
    ...(add ? [add] : [])
  );
  const body = h(
    'body',
    {},
    h('div', {}, h('p', {}, 'Une demande'), banner),
    h('div', {}, h('div', {}, h('p', {}, SECTION), row))
  );
  return { document: doc(body), banner, add };
}

{
  const p = page();
  ok(
    'an enabled panel button is marked and answered enabled',
    run(p.document) === 'enabled' && GRANT_ADD_MARK in p.add.attrs
  );
  ok('the banner beside it is never marked', !(GRANT_ADD_MARK in p.banner.attrs));
}
{
  const p = page({ disabled: true });
  ok(
    'a disabled panel button is marked and answered disabled (waited on, not clicked)',
    run(p.document) === 'disabled' && GRANT_ADD_MARK in p.add.attrs
  );
}
{
  const p = page({ staleOnBanner: true });
  run(p.document);
  ok(
    'a stale mark on the banner is removed when the panel button is marked',
    !(GRANT_ADD_MARK in p.banner.attrs) && GRANT_ADD_MARK in p.add.attrs
  );
}
{
  const p = page({ panelButton: false });
  ok(
    'a panel with no add button answers grant-panel-no-add-button beside a banner with one',
    run(p.document) === 'grant-panel-no-add-button'
  );
  ok('...and the banner is NOT marked', !(GRANT_ADD_MARK in p.banner.attrs));
}
{
  const p = page({ field: false });
  ok(
    'no search field answers grant-panel-no-field, it does not throw (a re-render is transient)',
    run(p.document) === 'grant-panel-no-field'
  );
  ok('...and the banner is NOT marked', !(GRANT_ADD_MARK in p.banner.attrs));
}
{
  const input = h('input', { placeholder: PLACEHOLDER });
  const banner = h('button', {}, ADD);
  const d = doc(h('body', {}, h('div', {}, banner), h('div', {}, input)));
  ok(
    'a field outside the section never climbs to the banner: grant-panel-no-section',
    run(d) === 'grant-panel-no-section' && !(GRANT_ADD_MARK in banner.attrs)
  );
}

// ── awaitGrantAdd: polls through a transient absence, names the last state when it stops ──────────
const noSleep = async () => {};
const reads = (seq) => {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
};
const rejects = async (p, re) => {
  try {
    await p;
    return false;
  } catch (e) {
    return re.test(String(e?.message));
  }
};
ok(
  'a field absent for two polls, then enabled: resolves',
  await awaitGrantAdd(
    reads(['grant-panel-no-field', 'grant-panel-no-field', 'disabled', 'enabled']),
    1000,
    noSleep
  ).then(
    () => true,
    () => false
  )
);
ok(
  'a section that never offers the button: rejects NAMING it',
  await rejects(
    awaitGrantAdd(reads(['grant-panel-no-add-button']), 30, noSleep),
    /^grant-panel-no-add-button: after 30 ms/
  )
);
ok(
  'a field that never comes back: rejects naming grant-panel-no-field',
  await rejects(
    awaitGrantAdd(reads(['grant-panel-no-field']), 30, noSleep),
    /^grant-panel-no-field:/
  )
);
ok(
  'a button that never enables: rejects naming grant-panel-add-disabled',
  await rejects(awaitGrantAdd(reads(['disabled']), 30, noSleep), /^grant-panel-add-disabled:/)
);
ok(
  'an answer outside the states is refused at once',
  await rejects(awaitGrantAdd(reads([true]), 1000, noSleep), /snippet answered true/)
);
{
  let n = 0;
  await awaitGrantAdd(async () => (n++, 'enabled'), 0, noSleep);
  ok('a zero timeout still reads once', n === 1);
}

if (failures) {
  console.error(`grantpanel-selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('grantpanel-selftest: ok');
