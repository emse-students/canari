/**
 * The vocabulary the COMM phase is written in: communities, channels, invitations, roles.
 *
 * WHY A MODULE AND NOT TWENTY-FIVE SCRIPTS THAT EACH KNOW THE UI. The dashboard carries 25 COMM
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

/**
 * Opens the open channel's settings modal, on its ACCESS tab.
 *
 * The gear in the channel header, not the community's: they carry different `aria-label`s for
 * exactly this reason, and clicking the wrong one lands on a modal whose "private" toggle does not
 * exist - a fifteen-second wait that reads as "the app has no visibility control".
 *
 * The tab is reached by its own caption rather than by position. It was a French literal in the
 * markup until 2026-08-20, which is what would have made this gesture the last French string in the
 * harness; `chat_channel_access_tab` exists because this needed it and the English app needed it
 * more.
 */
export async function openChannelAccess(cx) {
  await awaitAppSettled(cx);
  await realClick(cx, `[aria-label=${JSON.stringify(caption('chat_channel_settings_label'))}]`);
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_channel_settings_title'))}) >= 0`,
    10000
  );
  await realClick(cx, control('chat_channel_access_tab'));
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_channel_access_title'))}) >= 0`,
    10000
  );
  // THE TOGGLE, not the heading: the panel renders its title above a spinner while the access
  // state is still being fetched, so a read taken on the heading answers `isPrivate: null` for a
  // salon that is plainly private - an instrument reporting about itself.
  await until(cx, `!!document.querySelector('button[role=switch][aria-checked]')`, 15000);
}

/**
 * The access panel as the screen currently states it: `{ isPrivate, allowed, writePolicy }`.
 *
 * `isPrivate` is read from the toggle's `aria-checked` rather than from which of the two
 * descriptions is on screen - the descriptions are prose that can be reworded, `aria-checked` is
 * the control's own answer and is what a screen reader is told.
 *
 * `allowed` is the DISPLAYED members of the allowlist, which are display names and not ids: the
 * panel renders `<UserName>` and never shows an id. A check that needs ids reads them from the
 * database - which is where COMM-8 reads them anyway, since what it asks is what a device was sent.
 */
export async function channelAccessState(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `(function () {
         var sw = document.querySelector('button[role=switch][aria-checked]');
         var list = document.querySelector('ul');
         var allowed = list
           ? [].slice.call(list.querySelectorAll('li')).map(function (li) {
               return (li.innerText || '').split(String.fromCharCode(10))[0].trim();
             })
           : [];
         var sel = document.querySelector('select');
         return JSON.stringify({
           isPrivate: sw ? sw.getAttribute('aria-checked') === 'true' : null,
           allowed: allowed,
           writePolicy: sel ? sel.value : null,
         });
       })()`
    )
  );
}

/**
 * Sets the open channel's visibility toggle to `wanted` and returns whether it had to move it.
 *
 * IDEMPOTENT BY READING FIRST, because the control is a toggle and not a pair of radio buttons: a
 * check that clicks it unconditionally sets the state it wanted exactly when the state was already
 * wrong, which is the one case it was not testing.
 */
export async function setChannelPrivate(cx, wanted) {
  const before = await channelAccessState(cx);
  if (before.isPrivate === wanted) return false;
  await realClick(cx, 'button[role=switch][aria-checked]');
  await until(
    cx,
    `(function () {
       var sw = document.querySelector('button[role=switch][aria-checked]');
       return !!sw && sw.getAttribute('aria-checked') === ${JSON.stringify(String(wanted))};
     })()`,
    5000
  );
  return true;
}

/**
 * Grants a user access to the open private salon, by typing enough of their name to pick them.
 *
 * TYPED AND THEN PICKED, never assigned: the field is an autocomplete whose value is an id the
 * screen never shows, so the only path to a valid id is the one a person takes. The suggestion is
 * clicked by its rendered name, and the "add" button is asserted enabled first - it stays disabled
 * until a suggestion has actually been chosen, so a click before that is discarded in silence.
 */
export async function grantChannelAccess(cx, displayName) {
  const placeholder = caption('chat_search_user_placeholder');
  await realClick(cx, `input[placeholder=${JSON.stringify(placeholder)}]`);
  await cx.send('Input.insertText', { text: displayName });
  await until(cx, `!!${RESOLVE}('text=${displayName}')`, 8000);
  await realClick(cx, `text=${displayName}`);

  const add = caption('common_add_button');
  await until(
    cx,
    `(function () {
       var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
         return (x.innerText || '').indexOf(${JSON.stringify(add)}) >= 0;
       })[0];
       return !!b && !b.disabled;
     })()`,
    8000
  );
  await realClick(cx, `text=${add}`);
  return channelAccessState(cx);
}

/**
 * Revokes a user's access to the open private salon, confirming the dialog that guards it.
 *
 * THE REMOVAL IS IMMEDIATE - it does not wait for the save button, which is why it has a
 * confirmation of its own. A check that clicks the trash and then reads the panel without dealing
 * with the dialog reads the state BEFORE the removal and calls it a failure to remove.
 */
export async function revokeChannelAccess(cx, displayName) {
  const before = await channelAccessState(cx);
  const removed = await evaluate(
    cx,
    `(function () {
       var li = [].slice.call(document.querySelectorAll('li')).filter(function (x) {
         return (x.innerText || '').indexOf(${JSON.stringify(displayName)}) >= 0;
       })[0];
       if (!li) return 'no-row';
       var b = li.querySelector('button[title]');
       if (!b) return 'no-button';
       b.setAttribute('data-harness-revoke', '1');
       return 'marked';
     })()`
  );
  if (removed !== 'marked') throw new Error(`revokeChannelAccess: ${removed} for "${displayName}"`);
  await realClick(cx, '[data-harness-revoke]');
  // CONFIRMED, NEVER CLEARED. The first version called `clearOverlays` here, which presses Escape -
  // i.e. it CANCELLED the removal and then read a panel that had not changed, and reported the
  // absence of a removal as the app failing to remove. A dialog a check meant to answer is not
  // debris.
  await confirmDialog(cx, 'common_remove_label');
  // The row goes when the request lands, so the panel is waited for rather than read: reading it
  // immediately returns the list as it was and makes a slow server look like a refusal.
  await until(
    cx,
    `(function () {
       var rows = [].slice.call(document.querySelectorAll('li'));
       return rows.filter(function (x) {
         return (x.innerText || '').indexOf(${JSON.stringify(displayName)}) >= 0;
       }).length === 0;
     })()`,
    15000
  );
  return { before, after: await channelAccessState(cx) };
}

/**
 * Answers the app's ONE global confirmation dialog, by the caption of its confirming button.
 *
 * BY CAPTION AND NOT BY POSITION, because the dialog renders whatever label the caller passed -
 * "Retirer", "Supprimer", "Confirmer" - and the cancel button sits beside it. Clicking the wrong one
 * answers "no" to a question the check asked on purpose, which is indistinguishable from the app
 * refusing: that is exactly how COMM-9 first reported a removal that had never been requested.
 *
 * The dialog is `showConfirm` in `stores/confirm.svelte.ts`, rendered once in `+layout.svelte`, so
 * this one gesture serves every destructive control in the app.
 */
export async function confirmDialog(cx, confirmKey) {
  const label = caption(confirmKey);
  await until(
    cx,
    `(function () {
       return [].slice.call(document.querySelectorAll('button')).some(function (b) {
         return (b.innerText || '').trim() === ${JSON.stringify(label)};
       });
     })()`,
    10000
  );
  await realClick(cx, `text=${label}`);
}

/**
 * Saves the access panel and waits for the app's own confirmation that it landed.
 *
 * `common_saved_label` IS THE WITNESS, not the click: the save is a request, and a check that
 * returns as soon as the button was pressed is timing the harness rather than the app. The label is
 * transient, so it is waited for rather than asserted afterwards.
 */
export async function saveChannelAccess(cx) {
  await realClick(cx, control('common_save_button'));
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('common_saved_label'))}) >= 0`,
    15000
  );
  // THE GESTURE ENDS WITH THE SCREEN CLEAR, and that is not tidiness. The settings modal stays up
  // after a save, so the composer underneath it is covered: COMM-9/10 saved the roster, tried to
  // post, and died on `no stable element` for a composer that was plainly in the DOM - which is the
  // exact aftermath `clearOverlays` was written for. A gesture that leaves a modal behind is a fault
  // in the gesture, not in the check that comes next.
  return clearOverlays(cx);
}
