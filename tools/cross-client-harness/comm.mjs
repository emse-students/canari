/**
 * The vocabulary the COMM phase is written in: communities, channels, invitations, roles.
 *
 * WHY A MODULE AND NOT TWENTY-TWO SCRIPTS THAT EACH KNOW THE UI. The dashboard carries 22 COMM
 * checks and every one of them starts by creating or entering a community, so the same six or seven
 * gestures are about to be written 22 times. Written 22 times they drift, and a drifted gesture
 * fails as a defect: `openChannel` already carries the scar tissue for exactly one of them (settle
 * before EVERY click, hit-test the click itself, assert the selection before the composer) and none
 * of that survives being retyped.
 *
 * CAPTIONS ARE READ FROM THE REPOSITORY, NEVER SPELT HERE. Every control in this app is named by a
 * Paraglide message, and the harness sits in the same repository as `messages/fr.json` - so the
 * caption a runner clicks is READ from the very file the button renders from. A caption changed in
 * the app then changes here in the same commit, instead of turning 22 runners red with "no stable
 * element" a week later. It also keeps this file free of French literals, which is what a locale
 * switch on a client would otherwise break: `caption` can be pointed at `en.json` by `--locale`.
 *
 * WHAT IS DELIBERATELY NOT HERE: no assertions and no verdicts. This module performs gestures and
 * reports what the screen became; deciding whether that is a PASS belongs to the check, which is the
 * only thing that knows what it was asking. See `docs/wiki/testing-methodology.md` rule 19.
 */
import { readFileSync } from 'node:fs';
import { awaitAppSettled, awaitListed, clearOverlays, evaluate, goto, realClick, until } from './chat.mjs';
import { RESOLVE } from './cdp.mjs';

const LOCALE = process.argv.includes('--locale')
  ? process.argv[process.argv.indexOf('--locale') + 1]
  : 'fr';

/** Every user-visible string the app can render, in the locale the clients are running. */
const MESSAGES = JSON.parse(
  readFileSync(new URL(`../../frontend/messages/${LOCALE}.json`, import.meta.url), 'utf8')
);

/**
 * The text a control actually renders, by its Paraglide key.
 *
 * THROWS ON AN UNKNOWN KEY rather than returning undefined: a `text=undefined` selector matches
 * nothing and fails fifteen seconds later as "the control is missing", which is a diagnosis of the
 * app for a typo in the harness. A key that no longer exists is a harness fault and says so here.
 *
 * Parameterised messages are refused for the same reason. `{count} max` cannot be matched literally,
 * so a check that needs one must match its stable half explicitly and knowingly.
 */
export function caption(key) {
  const value = MESSAGES[key];
  if (typeof value !== 'string') {
    throw new Error(`caption: no message '${key}' in ${LOCALE}.json - the key was renamed or is a typo`);
  }
  if (value.includes('{')) {
    throw new Error(`caption: '${key}' is parameterised ("${value}") - match its stable half instead`);
  }
  return value;
}

/** `text=` selector for a control named by a Paraglide key. */
export const control = (key) => `text=${caption(key)}`;

/**
 * Puts the client on the communities screen with nothing covering it.
 *
 * Every gesture below starts here rather than assuming it. The app's panels hide their own
 * triggers, so a check that left the roles modal open makes the NEXT one fail on a button that is
 * plainly in the DOM - the failure `invite.mjs` documents and paid three runs for.
 */
export async function enterCommunities(cx) {
  await goto(cx, '/communities', { relaunch: 'no click path to /communities on the phone yet' });
  const debris = await clearOverlays(cx);
  await awaitAppSettled(cx);
  return debris;
}

/**
 * The communities in the rail, in rail order - which is the fact a reorder is read from.
 *
 * READ STRUCTURALLY, because there is nothing to read by name. The rail buttons carry the
 * community's name as their `aria-label` and nothing else, and that alone does not distinguish them
 * from every other labelled button on the page. What DOES distinguish them is where they sit: the
 * rail is the column that also holds the "add a community" button, so that button - locatable by a
 * caption this module reads from the app's own messages - is the anchor, and its siblings in that
 * column are the communities. No attribute was added to the app for the harness's benefit.
 */
export async function listCommunities(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `(function () {
         var add = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(caption('sidebar_add_community_title'))}) + ']');
         if (!add || !add.parentElement) return JSON.stringify([]);
         return JSON.stringify([].slice.call(add.parentElement.querySelectorAll('button[aria-label]'))
           .filter(function (b) { return b !== add; })
           .map(function (b) { return b.getAttribute('aria-label'); }));
       })()`
    )
  );
}

/**
 * Selects a community by name and waits for its channel list to be the one that belongs to it.
 *
 * Returns the click's own hit-test: a click that landed elsewhere and a community that rendered
 * nothing are two causes with opposite fixes, and no amount of waiting separates them.
 */
export async function openCommunity(cx, name) {
  await awaitListed(cx, `!!${RESOLVE}('text=${name}')`, 20000, 'the community', cx.port);
  await awaitAppSettled(cx);
  const point = await realClick(cx, `[aria-label=${JSON.stringify(name)}]`);
  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) >= 0`, 10000);
  return point.received ?? null;
}

/**
 * Creates a community through the UI and leaves the rail showing it.
 *
 * THE NAME IS TYPED, NOT ASSIGNED. `Input.insertText` after a real click is the input path a person
 * takes; setting `.value` and dispatching an event reaches the same binding by a route no user has,
 * and a check that used it would pass on a form the app had stopped listening to.
 *
 * THE SUBMIT BUTTON IS ASSERTED ENABLED FIRST. It stays disabled until the name lands, and a click
 * on a disabled control is discarded in silence - the same race `send` documents for the composer,
 * and the difference between "the community was not created" and "the click was thrown away".
 */
export async function createCommunity(cx, name) {
  await enterCommunities(cx);
  await realClick(cx, `[aria-label=${JSON.stringify(caption('sidebar_add_community_title'))}]`);
  await until(cx, `!!document.querySelector('#new-community-name')`, 10000);

  await realClick(cx, '#new-community-name');
  await cx.send('Input.insertText', { text: name });

  const submit = caption('chat_modal_create_community_button');
  await until(
    cx,
    `(function () {
       var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
         return (x.innerText || '').indexOf(${JSON.stringify(submit)}) >= 0;
       })[0];
       return !!b && !b.disabled;
     })()`,
    8000
  );
  await realClick(cx, `text=${submit}`);

  await awaitListed(cx, `!!${RESOLVE}('[aria-label=' + JSON.stringify(${JSON.stringify(name)}) + ']')`, 25000, 'the new community', cx.port);
  return name;
}

/**
 * Whether the open community lists a channel by this name, and whether it shows it as private.
 *
 * ASKED BY NAME RATHER THAN ENUMERATED, and that is a deliberate retreat. The channel rows carry
 * their name as an `aria-label` and nothing that distinguishes them from any other labelled button
 * on the page; the only structural anchor in their container is the "add a channel" button, which
 * is rendered ONLY for a member who may manage the community - so anchoring on it would go blind in
 * exactly the case COMM-8 exists to measure. An enumeration built on a CSS class would answer
 * confidently and wrongly, which is worse than answering less.
 *
 * Names in this phase carry a run marker, so a name is unique on the page by construction.
 *
 * @returns `{ present, isPrivate }` - `isPrivate` is read from the prefix the row announces.
 */
export async function channelRow(cx, name) {
  return JSON.parse(
    await evaluate(
      cx,
      `(function () {
         var priv = ${JSON.stringify(caption('chat_channel_private_label'))};
         var wanted = ${JSON.stringify(name)};
         var row = [].slice.call(document.querySelectorAll('button[aria-label]')).filter(function (b) {
           var l = b.getAttribute('aria-label') || '';
           var rest = l.indexOf(priv + ' ') === 0 ? l.slice(priv.length + 1) : l;
           var comma = rest.indexOf(', ');
           return (comma === -1 ? rest : rest.slice(0, comma)) === wanted;
         })[0];
         if (!row) return JSON.stringify({ present: false, isPrivate: false });
         var label = row.getAttribute('aria-label') || '';
         return JSON.stringify({ present: true, isPrivate: label.indexOf(priv + ' ') === 0 });
       })()`
    )
  );
}

/**
 * The channel the sidebar shows as open, or null.
 *
 * `aria-current` is the ONLY witness of a channel selection - selecting one changes no url, so the
 * address bar can never say which is open. It was added to the row for the screen reader that had
 * the same problem, and `openChannel` already leans on it for the same reason.
 */
export async function selectedChannel(cx) {
  const name = await evaluate(
    cx,
    `(function () {
       var priv = ${JSON.stringify(caption('chat_channel_private_label'))};
       var el = document.querySelector('button[aria-current][aria-label]');
       if (!el) return '';
       var l = el.getAttribute('aria-label') || '';
       var rest = l.indexOf(priv + ' ') === 0 ? l.slice(priv.length + 1) : l;
       var comma = rest.indexOf(', ');
       return comma === -1 ? rest : rest.slice(0, comma);
     })()`
  );
  return name || null;
}

/**
 * Creates a channel in the open community and returns its name.
 *
 * The trigger exists only for a member who may manage the community, so its absence is reported as
 * what it is - a permission - rather than as a control that would not click.
 */
export async function createChannel(cx, name, { visibility = 'public' } = {}) {
  const trigger = caption('chat_add_channel_label');
  const canManage = await evaluate(cx, `document.body.innerText.indexOf(${JSON.stringify(trigger)}) >= 0`);
  if (canManage !== 'true' && canManage !== true) {
    throw new Error(`createChannel: this account may not manage the open community (no "${trigger}")`);
  }
  await realClick(cx, `text=${trigger}`);
  await until(cx, `!!document.querySelector('#new-channel-name')`, 10000);

  await realClick(cx, '#new-channel-name');
  await cx.send('Input.insertText', { text: name });
  if (visibility === 'private') await realClick(cx, control('chat_channel_visibility_private'));

  const submit = caption('chat_modal_create_channel_button');
  await until(
    cx,
    `(function () {
       var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
         return (x.innerText || '').indexOf(${JSON.stringify(submit)}) >= 0;
       })[0];
       return !!b && !b.disabled;
     })()`,
    8000
  );
  await realClick(cx, `text=${submit}`);
  await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) >= 0`, 20000);
  return name;
}

/** Opens the community settings modal (the gear beside the community's name). */
export async function openCommunitySettings(cx) {
  await realClick(cx, `[aria-label=${JSON.stringify(caption('sidebar_community_settings_title'))}]`);
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_community_overview_tab'))}) >= 0`,
    10000
  );
}

/** Switches the open community-settings modal to one of its three tabs. */
export async function communityTab(cx, tab) {
  const key = { overview: 'chat_community_overview_tab', roles: 'chat_community_roles_tab', members: 'common_members_label' }[tab];
  if (!key) throw new Error(`communityTab: unknown tab '${tab}' - overview, roles or members`);
  await realClick(cx, control(key));
}

/**
 * The community's single invite link, generating it if there is none yet.
 *
 * READ FROM THE FIELD, NOT FROM THE CLIPBOARD. The copy button writes to a clipboard the harness
 * cannot read without a permission prompt, and the field beside it holds the same value - which is
 * also what a person actually shares. The field is `readonly`, which is what separates it from the
 * community-name input on the same modal.
 */
export async function inviteLink(cx) {
  await communityTab(cx, 'members');
  const generate = caption('chat_generate_invite_link_button');
  const present = await evaluate(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(generate)}) >= 0`
  );
  if (present === 'true' || present === true) await realClick(cx, `text=${generate}`);
  await until(cx, `!!document.querySelector('input[readonly]')`, 20000);
  return evaluate(cx, `(document.querySelector('input[readonly]') || {}).value || ''`);
}
