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
import { answeringDialogs, RESOLVE } from './cdp.mjs';

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

/**
 * A PARAMETERISED message, rendered with the values the app would render it with.
 *
 * {@link caption} refuses these, correctly: `{count} max` cannot be matched literally and a check
 * that tried would fail fifteen seconds later as "the control is missing". But some controls have
 * no other stable name - an unjoined private salon's row is named entirely by
 * `chat_channel_join_as_admin_aria`, placeholder and all - and spelling the French out in the check
 * would mean a reworded string turns the assertion into a silent no-op.
 *
 * So the message is still READ FROM THE APP'S OWN FILE and the placeholders are filled here. A
 * placeholder left over is a throw, not a selector nothing matches: `{name}` surviving into a
 * selector is the exact failure `caption` exists to prevent.
 *
 * @param key Paraglide key.
 * @param values Placeholder name to value, e.g. `{ name: 'c13-abc' }`.
 */
export function captionWith(key, values) {
  const value = MESSAGES[key];
  if (typeof value !== 'string') {
    throw new Error(`captionWith: no message '${key}' in ${LOCALE}.json - renamed or a typo`);
  }
  const filled = Object.entries(values).reduce(
    (text, [name, v]) => text.split(`{${name}}`).join(String(v)),
    value
  );
  if (filled.includes('{')) {
    throw new Error(`captionWith: '${key}' still has a placeholder after filling: "${filled}"`);
  }
  return filled;
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
  // IDEMPOTENT, because the gear is COVERED once the modal is up: clicking it a second time lands
  // on the overlay and the wait then times out on a modal that was already open. Detected by
  // "Quitter la communaute", which only this modal draws - the three tab captions are ordinary
  // words that appear elsewhere in the page, which is the whole subject of `communityTab` below.
  const marker = JSON.stringify(caption('chat_community_leave_button'));
  const alreadyOpen = await evaluate(cx, `document.body.innerText.indexOf(${marker}) >= 0`);
  if (alreadyOpen !== 'true' && alreadyOpen !== true) {
    await realClick(cx, `[aria-label=${JSON.stringify(caption('sidebar_community_settings_title'))}]`);
  }
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_community_overview_tab'))}) >= 0`,
    10000
  );
}

/**
 * Switches the community-settings modal to one of its three tabs, OPENING IT FIRST.
 *
 * IT USED TO ASSUME THE MODAL WAS ALREADY UP, and that is not a precondition a caller can be
 * trusted with - `inviteLink` did not know it and COMM-2 came back VACUOUS for it. The tab captions
 * are "Vue d'ensemble", "Roles & permissions" and "Membres", and a click by caption searches the
 * WHOLE document: with the modal closed, "Membres" matched the channel member list behind it, which
 * opened cleanly and looked like a working gesture. Nothing threw. The check then waited twenty
 * seconds for an invite field on a panel that has never had one.
 *
 * So the precondition is established here rather than asserted, which is what makes the gesture
 * safe to call from anywhere - the same shape `openCommunityMembers` was given for the same reason.
 */
export async function communityTab(cx, tab) {
  const key = { overview: 'chat_community_overview_tab', roles: 'chat_community_roles_tab', members: 'common_members_label' }[tab];
  if (!key) throw new Error(`communityTab: unknown tab '${tab}' - overview, roles or members`);
  await openCommunitySettings(cx);
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
 * Sets who may WRITE in the open salon, and reports whether it had to move the control.
 *
 * IDEMPOTENT BY READING FIRST, for the reason {@link setChannelPrivate} is: a check that sets a
 * value unconditionally is silent about the one case it was written for, which is the control
 * already holding something else.
 *
 * IT DOES NOT SAVE. `writePolicy` shares the access panel's one Save with the visibility toggle and
 * the allowlist, so a gesture that saved here would make a caller unable to change two things in
 * one round trip - and would hide which of them the server refused. {@link saveChannelAccess} stays
 * the caller's to invoke, once, deliberately.
 *
 * @param cx the client with the access panel open (see {@link openChannelAccess})
 * @param policy `everyone` | `admins_moderators` | `admins` - the option VALUES, not their labels
 */
export async function setChannelWritePolicy(cx, policy) {
  const before = await channelAccessState(cx);
  if (before.writePolicy === policy) return false;
  await chooseOption(cx, 'select', policy);
  await until(
    cx,
    `(function () {
       var sel = document.querySelector('select');
       return !!sel && sel.value === ${JSON.stringify(policy)};
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
export async function confirmDialog(cx, confirmKey, { typeText = null } = {}) {
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

  // THE TYPED HALF, when the dialog asks for it. `showConfirm({ requireText })` renders an input and
  // keeps the confirming button DISABLED until it matches - so a check that clicks straight through
  // clicks a dead button, waits, and reports the app as refusing to delete. The input is found by
  // its own accessible name, which is the only thing about it that is not a Tailwind class.
  if (typeText !== null) {
    const field = `input[aria-label=${JSON.stringify(caption('confirm_type_to_continue'))}]`;
    await until(cx, `!!document.querySelector(${JSON.stringify(field)})`, 10000);
    await realClick(cx, field);
    await cx.send('Input.insertText', { text: typeText });
    // The button is what the typing is FOR, so it is what proves the typing landed.
    await until(
      cx,
      `(function () {
         var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) {
           return (x.innerText || '').trim() === ${JSON.stringify(label)};
         })[0];
         return !!b && !b.disabled;
       })()`,
      10000
    );
  }

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

/**
 * Chooses a value in a native `<select>`, and makes the app hear it.
 *
 * A NATIVE SELECT CANNOT BE CLICKED THROUGH CDP: the option list is drawn by the operating system,
 * outside the page, so there is nothing to hit-test and `realClick` on an `<option>` finds nothing.
 * The value is therefore assigned and a bubbling `change` dispatched, which is precisely the event
 * the `onchange` handler is bound to - so what runs afterwards is the application's own code path,
 * not a shortcut around it.
 *
 * WHAT THIS DOES NOT PROVE, and no check may claim it does: that the option was REACHABLE. A select
 * rendered disabled, or one whose option list the app never populated, is refused here loudly
 * instead of silently succeeding - but "a person could have picked it" is a question for the eyes,
 * not for this gesture.
 */
export async function chooseOption(cx, selector, value) {
  const outcome = await evaluate(
    cx,
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return 'no-select';
       if (el.disabled) return 'disabled';
       var has = [].slice.call(el.options).some(function (o) { return o.value === ${JSON.stringify(value)}; });
       if (!has) return 'no-option:' + [].slice.call(el.options).map(function (o) { return o.value; }).join(',');
       el.value = ${JSON.stringify(value)};
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return 'chosen';
     })()`
  );
  if (outcome !== 'chosen') {
    throw new Error(`chooseOption: ${outcome} for ${selector} := ${value}`);
  }
}

/**
 * Marks the community-member row belonging to a display name, and returns the selector for it.
 *
 * FOUND BY WHAT THE ROW IS, NOT BY WHAT IT IS STYLED AS. The obvious selector is the Tailwind
 * container (`div.divide-y > div`), and it would break the first time somebody changed a class that
 * has nothing to do with membership. The predicate used instead is structural and says what a
 * member row actually IS: the SMALLEST element that contains both this person's name and exactly
 * one role control. Nothing else on the modal satisfies it, and no restyling can stop it doing so.
 *
 * It MARKS rather than returns a handle, for the same reason `revokeChannelAccess` does: the click
 * that follows goes through `realClick`, which hit-tests, and a hit-test needs a selector.
 */
async function markMemberRow(cx, displayName) {
  const marked = await evaluate(
    cx,
    `(function () {
       var name = ${JSON.stringify(displayName)};
       var all = [].slice.call(document.querySelectorAll('div, li, tr'));
       var rows = all.filter(function (el) {
         if ((el.innerText || '').indexOf(name) < 0) return false;
         if (el.querySelectorAll('select').length !== 1) return false;
         // Never the invite row, which shows the name of whoever the autocomplete has selected and
         // would hand a caller the invitation control where it asked for a member's.
         return !el.querySelector('input');
       });
       if (rows.length === 0) return 'no-row';
       rows.sort(function (a, b) { return a.innerText.length - b.innerText.length; });
       [].slice.call(document.querySelectorAll('[data-harness-member]')).forEach(function (e) {
         e.removeAttribute('data-harness-member');
       });
       rows[0].setAttribute('data-harness-member', '1');
       return 'marked';
     })()`
  );
  if (marked !== 'marked') throw new Error(`markMemberRow: ${marked} for "${displayName}"`);
  return '[data-harness-member]';
}

/**
 * The community's members as the modal shows them: `[{ name, role, readFrom }]`.
 *
 * THE ROLE IS READ FROM WHICHEVER CONTROL THIS VIEWER GETS, and the two are not the same evidence.
 * Someone who may manage the community sees a `<select>` whose VALUE is the role, straight from the
 * server; everyone else sees a badge whose TEXT is the role's translated label. Both are reported
 * through one shape and the caller is told which by `readFrom`, because a check asserting on a badge
 * is also asserting on `fr.json` - and a check that cannot tell the two apart will one day report
 * "the promotion did not happen" for a client that simply is not an admin.
 */
export async function communityMembers(cx) {
  const raw = await evaluate(
    cx,
    `(function () {
       var NL = String.fromCharCode(10);
       var byRole = {};
       byRole[${JSON.stringify(caption('chat_role_admin'))}] = 'admin';
       byRole[${JSON.stringify(caption('chat_role_moderator'))}] = 'moderator';
       byRole[${JSON.stringify(caption('chat_role_member'))}] = 'member';

       // THE ROW IS THE FIRST ANCESTOR THAT SAYS MORE THAN THE CONTROL DOES. A native select's
       // innerText is ALL of its options ("Membre/Moderateur/Administrateur"), and the two wrappers
       // above it repeat exactly that - which is why "the smallest element holding one select" found
       // a wrapper and reported every member as being called "Membre". Walking up until the text
       // CHANGES lands on the row, whatever it is styled as, and what changed is the name.
       var out = [];
       [].slice.call(document.querySelectorAll('select')).forEach(function (sel) {
         var opts = [].slice.call(sel.options).map(function (o) { return o.value; });
         if (opts.indexOf('moderator') < 0 || opts.indexOf('admin') < 0) return;

         var selText = (sel.innerText || '').trim();
         var row = sel.parentElement;
         while (row && (row.innerText || '').trim() === selText) row = row.parentElement;
         if (!row) return;

         // THE INVITE ROW CARRIES THE SAME THREE OPTIONS and is not a member. It is told apart by
         // the autocomplete beside it: a member row contains no <input> at all, and that is a fact
         // about what the two rows DO rather than about how either is styled.
         if (row.querySelector('input')) return;

         var name = (row.innerText || '').replace(selText, '').trim().split(NL)[0].trim();
         if (!name) return;
         out.push({ name: name, role: sel.value, readFrom: 'select' });
       });
       if (out.length) return JSON.stringify(out);

       // The view of somebody who may not manage: no selects at all, one badge per row.
       var badges = [].slice.call(document.querySelectorAll('span')).filter(function (sp) {
         return byRole[(sp.innerText || '').trim()] !== undefined;
       });
       return JSON.stringify(badges.map(function (sp) {
         var label = (sp.innerText || '').trim();
         var row = sp.parentElement;
         while (row && (row.innerText || '').trim() === label) row = row.parentElement;
         return {
           name: ((row && row.innerText) || '').replace(label, '').trim().split(NL)[0].trim(),
           role: byRole[label],
           readFrom: 'badge',
         };
       }).filter(function (m) { return m.name.length > 0; }));
     })()`
  );
  return JSON.parse(raw);
}

/**
 * Puts the client on the community settings' members tab, and waits for the roster to have LOADED.
 *
 * IDEMPOTENT ABOUT WHAT IT FINDS, and that is the whole point of it existing. The gear that opens
 * the settings is COVERED once the settings are open, so a second call would wait fifteen seconds
 * for a button that is plainly in the DOM - the failure `openChannel` already carries scar tissue
 * for. So the modal is opened only when it is not already up, and the tab is asked for either way.
 *
 * IT IS ALSO WHY THE ROLE GESTURES BELOW CALL IT THEMSELVES. COMM-5's first run read an empty
 * roster three times running and passed anyway, because its assertions happened not to depend on
 * the reading: the panel had drifted off the members tab between the setup and the promotion, and
 * nothing noticed. A gesture that needs a screen must ESTABLISH it, never assume the caller left it
 * that way - an assumption that is right nine times out of ten is how a check reports an empty list
 * as a fact about the community.
 */
export async function openCommunityMembers(cx) {
  const count = caption('chat_community_member_count_label');
  const alreadyOpen = await evaluate(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(count)}) >= 0`
  );
  if (alreadyOpen !== 'true' && alreadyOpen !== true) {
    await openCommunitySettings(cx);
  }
  await communityTab(cx, 'members');
  // THE LOADING LINE IS WAITED OUT, not the heading: the heading renders before the request returns,
  // so a check that reads the roster immediately reads an EMPTY list and calls it a community with
  // no members - which is how an assertion of absence passes for entirely the wrong reason.
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_community_loading_members'))}) < 0`,
    20000
  );
  // AND THE ROSTER IS WAITED FOR, not merely the absence of the spinner: the member-count header
  // renders at zero while the list is still arriving, so "no loading line" is not "the members are
  // here". The count is the app's own statement about how many it has.
  await until(
    cx,
    `(function () {
       var t = document.body.innerText || '';
       var i = t.indexOf(${JSON.stringify(count)});
       if (i < 0) return false;
       return document.querySelectorAll('select').length > 1;
     })()`,
    20000
  ).catch(() => {});
  return communityMembers(cx);
}

/**
 * Sets a member's community role, and waits for the app to stop saving it.
 *
 * THE RE-ENABLED CONTROL IS THE WITNESS, not the choosing: the handler disables the select, sends
 * the request and re-enables it. A check that reads the roster the instant it has chosen reads back
 * the value it typed in, which is a statement about the harness and not about the server.
 */
export async function setMemberRole(cx, displayName, role) {
  if (!['member', 'moderator', 'admin'].includes(role)) {
    throw new Error(`setMemberRole: unknown role '${role}'`);
  }
  const before = await openCommunityMembers(cx);
  const row = await markMemberRow(cx, displayName);
  await chooseOption(cx, `${row} select`, role);

  // WAITED FOR ON THE ROSTER, NEVER ON THE CONTROL. The first version waited for
  // `!(document.querySelector(row + ' select') || {}).disabled` - which is TRUE the moment the row
  // DISAPPEARS, because `(undefined || {}).disabled` is undefined and `!undefined` is true. The list
  // re-renders while the update lands, so the wait was satisfied by the row going away rather than
  // by the save completing, and the read that followed returned an empty roster three times in a
  // row while COMM-5 passed on assertions that happened not to look at it.
  //
  // The condition is now the answer itself: this person, present, carrying the new role.
  return { before, after: await awaitMemberRole(cx, displayName, role) };
}

/**
 * Polls the roster until `displayName` carries `role`, and returns the roster either way.
 *
 * RETURNS RATHER THAN THROWS on the timeout, because "the panel never showed the new role" is a
 * result the check must be free to record and reason about - throwing here would turn a finding
 * about the application into a failed gesture, which reads as a broken harness.
 */
async function awaitMemberRole(cx, displayName, role, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    last = await communityMembers(cx).catch(() => []);
    if (last.some((m) => m.name.includes(displayName) && m.role === role)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 700));
  }
}

/**
 * Removes a member from the community outright, answering the confirmation it raises.
 *
 * The row's only BUTTON is the removal - the role control beside it is a `<select>` - which is what
 * makes addressing it structurally safe: there is nothing else in the row to click by accident.
 */
export async function removeCommunityMember(cx, displayName) {
  const before = await openCommunityMembers(cx);
  const row = await markMemberRow(cx, displayName);
  await realClick(cx, `${row} button`);
  await confirmDialog(cx, 'common_remove_label');

  // GONE FROM A ROSTER THAT STILL HAS PEOPLE IN IT. "The marked row no longer names them" is also
  // true of a list that has emptied itself mid-render, and a removal check must not accept that:
  // it is the same mistake as waiting on a control that has been unmounted. The community always
  // retains at least the admin doing the removing, so a non-empty roster is a fair precondition.
  const deadline = Date.now() + 20000;
  let after = [];
  for (;;) {
    after = await communityMembers(cx).catch(() => []);
    if (after.length > 0 && !after.some((m) => m.name.includes(displayName))) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  return { before, after };
}

/**
 * Sends a direct invitation to one person, at a chosen role, from the members tab.
 *
 * NOT THE SAME THING AS THE LINK, and the difference is the whole of COMM-4: a link is a URL anyone
 * holding it may use, while this creates an invitation addressed to one account and delivered into
 * the DM with them. The modal's status line is RETURNED rather than asserted - what it says is the
 * check's question, including when what it says is that the invitation could not be sent.
 */
export async function inviteToCommunity(cx, displayName, role = 'member') {
  await communityTab(cx, 'members');
  const placeholder = caption('chat_community_search_user_placeholder');
  await realClick(cx, `input[placeholder=${JSON.stringify(placeholder)}]`);
  await cx.send('Input.insertText', { text: displayName });
  await until(cx, `!!${RESOLVE}('text=${displayName}')`, 10000);
  await realClick(cx, `text=${displayName}`);

  // The invite row's select is the one that is NOT inside a member row, and the autocomplete input
  // carries the only stable id on the modal - so the row is reached from it rather than by counting.
  const inviteSelect = await evaluate(
    cx,
    `(function () {
       var input = document.querySelector('#community-invite-autocomplete');
       if (!input) return 'no-input';
       var box = input;
       while (box && box.querySelectorAll('select').length === 0) box = box.parentElement;
       if (!box) return 'no-select';
       box.querySelector('select').setAttribute('data-harness-invite-role', '1');
       return 'marked';
     })()`
  );
  if (inviteSelect !== 'marked') throw new Error(`inviteToCommunity: ${inviteSelect}`);
  await chooseOption(cx, '[data-harness-invite-role]', role);
  await realClick(cx, control('chat_community_generate_invite_button'));

  // The click returns long before the request does, so the SENDING label is waited out rather than
  // the status line waited for: a status line that never changes is itself an answer worth keeping.
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('common_sending_label'))}) < 0`,
    25000
  );
  return evaluate(
    cx,
    `(function () {
       var input = document.querySelector('#community-invite-autocomplete');
       var box = input;
       while (box && box.querySelectorAll('button').length < 2) box = box.parentElement;
       return (box && box.innerText) || '';
     })()`
  );
}

/**
 * Leaves the open community, answering the confirmation.
 *
 * WHAT MAKES THIS WORTH A GESTURE rather than two clicks inside a check: leaving is the one action
 * in this module with a cryptographic half. The device must also leave the community's distribution
 * group and every private salon's, and the server must drop its routing rows - so what a check does
 * NEXT is read the database, and it must not also be debugging the click that got it here.
 */
export async function leaveCommunity(cx) {
  await openCommunitySettings(cx);
  await realClick(cx, control('chat_community_leave_button'));
  await confirmDialog(cx, 'common_leave_button');
  return clearOverlays(cx);
}

/**
 * Deletes the whole community, typing its name as the dialog demands.
 *
 * THE TYPED NAME IS NOT A FORMALITY: the server re-checks it, so a check that gets the name wrong
 * gets a refusal from the API rather than merely a dead button - two different failures that look
 * identical from the screen. It is passed in by the caller, the only party that knows what it made.
 */
export async function deleteCommunity(cx, name) {
  await openCommunitySettings(cx);
  await realClick(cx, control('chat_community_delete_button'));
  await confirmDialog(cx, 'common_delete_button', { typeText: name });
  return clearOverlays(cx);
}

/**
 * Deletes the OPEN channel from its settings modal.
 *
 * NO TYPED NAME HERE, and the asymmetry with {@link deleteCommunity} is the product's, not an
 * oversight: a channel takes an ordinary confirmation, a community makes you type what you are
 * about to destroy. A check that assumed one shape for both would answer "no" to a question it
 * meant to answer "yes" - which reads exactly like the app refusing.
 */
export async function deleteChannel(cx) {
  await awaitAppSettled(cx);
  await realClick(cx, `[aria-label=${JSON.stringify(caption('chat_channel_settings_label'))}]`);
  await until(
    cx,
    `document.body.innerText.indexOf(${JSON.stringify(caption('chat_channel_settings_title'))}) >= 0`,
    10000
  );
  await realClick(cx, control('chat_delete_channel_button'));
  await confirmDialog(cx, 'common_delete_button');
  return clearOverlays(cx);
}

/**
 * Opens an invite link on a client and reports what the landing page SAYS, without joining.
 *
 * THE PREVIEW IS THE HALF THAT MATTERS AND THE HALF NOBODY WOULD CHECK. Accepting a link is easy to
 * assert - a membership row appears. What a link is FOR is telling you what you are about to join
 * before you join it, and a preview that renders an empty name, or renders "invalid" for a perfectly
 * good link, is invisible from the database. So this returns the community's name as drawn, and
 * whether the page decided the link is usable, and joins nothing.
 *
 * `goto` takes a PATH, and an invite link is an absolute URL - the path is taken from it rather than
 * rebuilt, so a link whose shape changes is followed rather than silently mis-navigated.
 *
 * @param {string} url the absolute invite URL, as {@link inviteLink} returns it
 * @returns `{ valid, name }` - `name` is null when the page refused the link
 */
export async function openInviteLink(cx, url) {
  const path = new URL(url).pathname;
  await goto(cx, path);
  const refused = JSON.stringify(caption('invite_invalid_or_expired'));
  const joinable = JSON.stringify(caption('community_join_btn'));
  await until(
    cx,
    `document.body.innerText.indexOf(${refused}) >= 0 || document.body.innerText.indexOf(${joinable}) >= 0`,
    25000
  );
  const valid = await evaluate(cx, `document.body.innerText.indexOf(${joinable}) >= 0`);
  if (valid !== 'true' && valid !== true) return { valid: false, name: null };

  // ANCHORED ON THE APP'S OWN SENTENCE, not on "the first line that is not a caption I know". That
  // was the first spelling and it read "Aller au contenu principal" - the skip-to-content link,
  // which is line one of `document.body.innerText` on every page in this application. A reader
  // defined by what it EXCLUDES is only ever as right as its exclusion list; this one is defined by
  // what it FOLLOWS, and "Vous avez ete invite(e) a rejoindre" is drawn immediately above the name
  // by the same component.
  const invited = JSON.stringify(caption('community_join_invited_text'));
  const NL = 'String.fromCharCode(10)';
  const name = await evaluate(
    cx,
    `(function () {
      var lines = (document.body.innerText || '').split(${NL})
        .map(function (l) { return l.trim(); })
        .filter(Boolean);
      var at = lines.indexOf(${invited});
      return at >= 0 && at + 1 < lines.length ? lines[at + 1] : '';
    })()`
  );
  return { valid: true, name: String(name || '').trim() };
}

/**
 * Accepts the invite currently previewed on this client, and waits until it has LEFT the join page.
 *
 * The button is not the end of the gesture: accepting navigates into the community's first channel,
 * and a check that asserted right after the click would be reading the join page's DOM. Waiting on
 * the URL rather than on any rendered text is deliberate - the destination depends on whether the
 * community has a channel at all, and both destinations are a success.
 */
export async function acceptInviteLink(cx) {
  await realClick(cx, `text=${caption('community_join_btn')}`);
  await until(cx, `location.pathname.indexOf('/c/join/') < 0`, 30000);
  return awaitAppSettled(cx);
}

/**
 * Sets the bounds the NEXT minted link will carry - expiry in days, uses in count.
 *
 * THEY APPLY AT MINT, NOT TO THE LIVE LINK. Both are read when the link is created or regenerated,
 * so setting them and then reading the existing link changes nothing: call this, then
 * {@link rotateInvite}. A check that set a cap and asserted on the link already on screen would be
 * asserting about a token minted before the cap existed.
 *
 * THE SELECTS ARE FOUND BY THEIR LABEL, and marked for one call. They carry no id, no name and no
 * test hook, and there are two of them side by side - so an index would silently swap expiry for
 * uses the day a third bound is added, which is a check that passes while measuring the wrong
 * control. The marker attribute is set and removed inside this gesture; nothing outside it ever
 * sees the DOM changed.
 *
 * @param opts `{ expiryDays, maxUses }` - `0` is the app's own value for "never" / "unlimited",
 *   and omitting a key leaves that control alone
 */
/**
 * Chooses a value in whichever `<select>` a search expression finds, and leaves the DOM as it was.
 *
 * THE SELECTS IN THE COMMUNITY PANEL CARRY NO ID, NO NAME AND NO TEST HOOK, and there are several of
 * them - invite expiry, invite uses, history visibility - so each has to be identified by something.
 * WHAT that something is differs per control and is the caller's business; the marking, the choosing
 * and the unmarking do not differ at all, and are here.
 *
 * `find` is a JS expression evaluated in the page, returning the element or a falsy value. The marker
 * attribute exists only for the duration of this call, so nothing outside it ever observes the DOM
 * changed - and it is removed in a `finally`, or a failed choice would poison every later pick.
 *
 * @param who the caller's name, so a failure says which control was not found
 */
async function pickSelect(cx, find, value, who) {
  const found = await evaluate(
    cx,
    `(function () {
       var el = ${find};
       if (!el) return 'not-found';
       el.setAttribute('data-harness-pick', '');
       return 'ok';
     })()`
  );
  if (found !== 'ok') throw new Error(`${who}: no select matched`);
  try {
    await chooseOption(cx, 'select[data-harness-pick]', String(value));
  } finally {
    await evaluate(
      cx,
      `(function () {
         var s = document.querySelector('select[data-harness-pick]');
         if (s) s.removeAttribute('data-harness-pick');
         return 'ok';
       })()`
    );
  }
}

/** The `<select>` inside the `<label>` whose text opens with `labelText`. */
const selectUnderLabel = (labelText) =>
  `(function () {
     var labels = [].slice.call(document.querySelectorAll('label'));
     for (var i = 0; i < labels.length; i++) {
       if ((labels[i].innerText || '').trim().indexOf(${JSON.stringify(labelText)}) !== 0) continue;
       var s = labels[i].querySelector('select');
       if (s) return s;
     }
     return null;
   })()`;

/**
 * The one `<select>` offering exactly this set of option VALUES.
 *
 * STRONGER THAN ANY LABEL, where it applies. An option's value is the token sent to the server and
 * stored in the column - it is the contract, and changing it is a migration. The captions beside it
 * are prose the product rewords freely, and the history control's caption is not even inside its
 * `<label>`: it sits in a sibling paragraph, so the label-based search finds nothing at all there.
 */
const selectOffering = (values) =>
  `[].slice.call(document.querySelectorAll('select')).filter(function (s) {
     var v = [].slice.call(s.options).map(function (o) { return o.value; });
     return ${JSON.stringify(values)}.every(function (w) { return v.indexOf(w) >= 0; });
   })[0]`;

export async function setInviteBounds(cx, { expiryDays = null, maxUses = null } = {}) {
  await communityTab(cx, 'members');
  const pick = (key, value) =>
    pickSelect(cx, selectUnderLabel(caption(key)), value, 'setInviteBounds');
  if (expiryDays !== null) await pick('chat_community_invite_expiry_label', expiryDays);
  if (maxUses !== null) await pick('chat_community_invite_max_uses_label', maxUses);
}

/**
 * Sets what a NEWCOMER may read of what was said before they arrived.
 *
 * THE SERVER STORES THIS AND CANNOT ENFORCE IT. It holds no seed, so the rule is applied by the
 * MEMBER whose device answers a newcomer's history request - `gatherCommunityHistory` refuses
 * outright under `joined` and sends every seed it holds under `shared`. There is no middle: `joined`
 * is not "seeds from your arrival onwards", it is NO history bundle at all, and the newcomer reads
 * what comes after them only because those seeds are distributed live, to everyone, as they are
 * minted.
 *
 * SET IT BEFORE ANYBODY JOINS. The value travels to the other members as a workspace update, and a
 * newcomer's request is answered with whatever the ANSWERING device believes at that moment - so a
 * change made while a join is in flight has no defined outcome, and no check may assert one.
 *
 * @param visibility `'shared'` or `'joined'` - the stored values, never the drawn captions
 */
export async function setHistoryVisibility(cx, visibility) {
  if (visibility !== 'shared' && visibility !== 'joined') {
    throw new Error(`setHistoryVisibility: '${visibility}' is neither 'shared' nor 'joined'`);
  }
  await communityTab(cx, 'overview');
  await pickSelect(cx, selectOffering(['shared', 'joined']), visibility, 'setHistoryVisibility');
  return clearOverlays(cx);
}

/**
 * Regenerates the community's invite link and returns the NEW one.
 *
 * REGENERATING REVOKES THE PREVIOUS TOKEN, which the panel says in so many words and which is the
 * only way to revoke one at all - there is no separate revoke control, by design: one live link at
 * a time is what makes it enumerable, and a link nobody can enumerate is not revocable.
 *
 * The returned value is asserted to have CHANGED, because the failure this gesture can have is
 * silent: a click that missed leaves the old token in the field and every assertion downstream then
 * describes the link the check believed it had replaced.
 */
export async function rotateInvite(cx) {
  await communityTab(cx, 'members');
  const before = await evaluate(cx, `(document.querySelector('input[readonly]') || {}).value || ''`);
  // THERE IS NOTHING TO ROTATE ON A COMMUNITY WITH NO LINK, and the control is not even the same
  // one - the panel draws "Generer un lien d'invitation" until a link exists and "Regenerer"
  // afterwards. Refused here rather than absorbed: a caller wanting the FIRST mint wants
  // `inviteLink`, which creates with whatever bounds are set, and silently doing that instead
  // would make this gesture report a rotation that never happened. COMM-3 met exactly this and
  // spent twenty seconds waiting on a field that was never going to change.
  if (!before) {
    throw new Error('rotateInvite: no live link to rotate - use inviteLink() for the first mint');
  }
  await realClick(cx, control('chat_regenerate_link_button'));
  await until(
    cx,
    `(function () {
       var el = document.querySelector('input[readonly]');
       return !!el && !!el.value && el.value !== ${JSON.stringify(before)};
     })()`,
    20000
  );
  return evaluate(cx, `(document.querySelector('input[readonly]') || {}).value || ''`);
}

/**
 * Marks the `index`-th match of a CSS selector so a real click can reach it.
 *
 * `document.querySelector` returns the first match and nothing in this app gives its repeated
 * fields an id, so the second option field of a poll cannot be named at all. Marked here and then
 * CLICKED for real, rather than focused from script: a click is the gesture, and `el.focus()` skips
 * whatever the component does on pointerdown - which is exactly the kind of shortcut that makes a
 * harness agree with a product that no longer works.
 */
async function markNth(cx, css, index, tag) {
  const outcome = await evaluate(
    cx,
    `(function () {
       var all = [].slice.call(document.querySelectorAll(${JSON.stringify(css)}));
       var el = all[${index}];
       if (!el) return 'no-element';
       el.setAttribute('data-harness', ${JSON.stringify(tag)});
       return 'marked';
     })()`
  );
  if (outcome !== 'marked') throw new Error(`markNth(${css}, ${index}): ${outcome}`);
  return `[data-harness=${JSON.stringify(tag)}]`;
}

/** Opens the poll composer from the message composer. Channels only - a DM has no such button. */
export async function openPollComposer(cx) {
  const label = caption('chat_create_poll_label');
  await realClick(cx, `[aria-label=${JSON.stringify(label)}]`);
  await until(cx, `!!document.querySelector('#poll-question')`, 10000);
}

/**
 * Fills the poll composer and sends it. Returns nothing - what the poll BECAME is read from the
 * card and from the database, never from the form that was just used to type it.
 *
 * The modal ships exactly two option fields and grows one per "Ajouter une option", so a poll of
 * three options needs one click before the third field exists. Written as a loop over the wanted
 * options rather than as a special case, because a check asking for two must exercise the same code
 * as one asking for four.
 */
export async function composePoll(cx, { question, options, multiple = false }) {
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('composePoll: a poll needs at least two options');
  }
  await realClick(cx, '#poll-question');
  await cx.send('Input.insertText', { text: question });

  const field = `input[placeholder=${JSON.stringify(caption('channel_poll_option_placeholder'))}]`;
  for (let i = 0; i < options.length; i++) {
    if (i >= 2) {
      await realClick(cx, control('channel_poll_add_option'));
      await until(cx, `document.querySelectorAll(${JSON.stringify(field)}).length > ${i}`, 8000);
    }
    await realClick(cx, await markNth(cx, field, i, `poll-option-${i}`));
    await cx.send('Input.insertText', { text: options[i] });
  }

  if (multiple) await realClick(cx, control('post_poll_allow_multiple_label'));

  const submit = caption('channel_poll_submit_button');
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
  // The modal closes only once the send RESOLVED, so its disappearance is the send's own receipt.
  await until(cx, `!document.querySelector('#poll-question')`, 30000);
}

/**
 * The poll card as this client renders it, or `{ present: false }`.
 *
 * READ BY QUESTION, because a salon may carry several polls and a check that read "the card" would
 * silently follow whichever rendered first. Every figure a check could want comes from the card
 * itself - the option labels, each option's tally, whether THIS client shows it selected
 * (`aria-pressed`), and whether the poll is over - so a runner never has to re-derive a percentage.
 *
 * `closable` is the author's / moderator's "Cloturer le sondage" being offered, which is a
 * permission statement rather than a styling one. It sits OUTSIDE the card, beside it, so it is
 * looked for in the parent.
 */
export async function pollCard(cx, question) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify((function () {
         var heads = [].slice.call(document.querySelectorAll('h4')).filter(function (h) {
           return (h.innerText || '').trim() === ${JSON.stringify(question)};
         });
         if (heads.length === 0) return { present: false, cards: 0 };
         // The card is the nearest ancestor holding the option buttons - found by walking up rather
         // than by class, so a restyling moves nothing here.
         var card = heads[0];
         while (card && card.querySelectorAll('button[aria-pressed]').length === 0) card = card.parentElement;
         if (!card) return { present: true, cards: heads.length, options: [], ended: null, closable: null };
         var buttons = [].slice.call(card.querySelectorAll('button[aria-pressed]'));
         var options = buttons.map(function (b) {
           var label = b.querySelector('span.truncate');
           var badge = b.querySelector('[role="button"]');
           return {
             label: label ? (label.innerText || '').trim() : '',
             votes: badge ? Number((badge.innerText || '').trim()) : null,
             selected: b.getAttribute('aria-pressed') === 'true',
           };
         });
         var text = card.innerText || '';
         var around = card.parentElement ? card.parentElement.innerText || '' : text;
         return {
           present: true,
           cards: heads.length,
           options: options,
           ended: text.indexOf(${JSON.stringify(caption('post_poll_ended_full_label'))}) >= 0,
           closable: around.indexOf(${JSON.stringify(caption('channel_poll_close_button'))}) >= 0,
         };
       })())`
    )
  );
}

/**
 * Clicks one option of a poll. A single-choice poll SENDS on the click; a multiple-choice one only
 * toggles, and the caller then sends with `submitPollVote`.
 *
 * The option is looked up on the card first so an absent label fails as "that is not an option",
 * naming the ones there are, rather than as a click that found nothing fifteen seconds later.
 */
export async function votePollOption(cx, question, label) {
  const card = await pollCard(cx, question);
  if (!card.present) throw new Error(`votePollOption: no poll card for ${JSON.stringify(question)}`);
  if (!card.options.some((o) => o.label === label)) {
    throw new Error(
      `votePollOption: ${JSON.stringify(label)} is not an option - ` +
        JSON.stringify(card.options.map((o) => o.label))
    );
  }
  await realClick(cx, `text=${label}`);
}

/** Sends a multiple-choice selection ("Voter"). Single-choice polls never draw this button. */
export async function submitPollVote(cx) {
  await realClick(cx, control('post_sondage_voter'));
}

/**
 * Closes a poll early, ANSWERING THE NATIVE CONFIRMATION and returning what it said.
 *
 * This is the one confirmation in the product that is a `window.confirm` rather than the styled
 * dialog every other destructive action uses - so it blocks the renderer, and every gesture in this
 * module would hang behind it. `answeringDialogs` accepts the real dialog rather than replacing it;
 * the returned message is the evidence that the app asked before closing, which is the whole
 * difference between a confirmed close and a click that closed a poll silently.
 */
export async function closePollCard(cx) {
  const { dialogs } = await answeringDialogs(cx, () =>
    realClick(cx, control('channel_poll_close_button'))
  );
  return dialogs;
}

/*
 * THE PERMISSION GRID - two gestures, shared because two checks now drive it.
 *
 * They were COMM-6's until COMM-20 needed the same table for a different question (what two
 * administrators editing one role at the same moment leave behind). Copying them would have been the
 * fourth time a gesture in this phase drifted between its callers.
 */
/**
 * The grid as the panel draws it: `{ permissions, roles, adminLocked }`.
 *
 * READ AS A TABLE, WHICH IS WHAT IT IS. Each `tbody` row is one permission and its first cell is
 * the label; each header cell after the first is a role. Nothing here depends on a class name -
 * the structure IS the meaning, and a restyling that changed the colours would not move a cell.
 *
 * `adminLocked` is the top role's column being disabled, which is the panel's own statement that
 * the administrator cannot be stripped of anything. Read from `disabled` rather than from opacity.
 */
export async function permissionGrid(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify((function () {
         var table = document.querySelector('table');
         if (!table) return { permissions: null, roles: null, adminLocked: null };
         var head = [].slice.call(table.querySelectorAll('thead th'));
         var roles = head.slice(1).map(function (th) { return (th.innerText || '').trim(); });
         var body = [].slice.call(table.querySelectorAll('tbody tr'));
         var permissions = body.map(function (tr) {
           var cells = [].slice.call(tr.children);
           return (cells[0] ? cells[0].innerText || '' : '').trim();
         });
         // The administrator is the FIRST column: the grid sorts roles by descending priority.
         var lockedColumn = body.every(function (tr) {
           var cell = tr.children[1];
           var button = cell ? cell.querySelector('button') : null;
           return !!button && button.disabled === true;
         });
         // EACH CELL'S STATE, READ FROM ITS ICON. The grid draws allow / deny / neutral as three
         // lucide glyphs, and the icon is the only structural carrier: the colour lives in a class
         // and the wording in a parameterised tooltip, neither of which a check may depend on.
         // cells[row][col] is aligned with permissions[row] and roles[col].
         var cells = body.map(function (tr) {
           return [].slice.call(tr.children).slice(1).map(function (td) {
             var svg = td.querySelector('button svg');
             var cls = svg ? String(svg.getAttribute('class') || '') : '';
             if (cls.indexOf('lucide-check') !== -1) return 'allow';
             if (cls.indexOf('lucide-x') !== -1) return 'deny';
             if (cls.indexOf('lucide-minus') !== -1) return 'neutral';
             return null;
           });
         });
         return { permissions: permissions, roles: roles, adminLocked: lockedColumn, cells: cells };
       })())`
    )
  );
}

/**
 * Clicks the cell at (permission label, role column index), which CYCLES it.
 *
 * The grid has no per-cell hook, so the cell is reached the same way it is read: by the row whose
 * first cell carries the label, then by column. The button is marked and clicked through the DOM
 * rather than hit-tested, because a table cell inside a horizontally scrolling container can sit
 * outside the viewport - and a `realClick` that scrolls the container first is a gesture about
 * scrolling.
 */
export async function cyclePermissionCell(cx, label, column) {
  const outcome = await evaluate(
    cx,
    `(function () {
       var body = [].slice.call(document.querySelectorAll('table tbody tr'));
       var row = body.filter(function (tr) {
         var first = tr.children[0];
         return first && (first.innerText || '').trim() === ${JSON.stringify(label)};
       })[0];
       if (!row) return 'no-row';
       var cell = row.children[${column}];
       var button = cell ? cell.querySelector('button') : null;
       if (!button) return 'no-button';
       if (button.disabled) return 'disabled';
       button.click();
       return 'clicked';
     })()`
  );
  if (outcome !== 'clicked') throw new Error(`cyclePermissionCell(${label}, ${column}): ${outcome}`);
}

/**
 * The six permissions something enforces, each with the label the grid renders it as.
 *
 * ONE COPY, because two checks now need to cross the same seam in opposite directions: COMM-6 asks
 * whether the grid offers exactly these six, and COMM-20 has to compare what a grid SHOWS (labels)
 * against what the column HOLDS (keys). A second mapping in a runner would be a third statement of
 * the same fact, and the one that silently goes stale.
 *
 * The order is the order the panel lists them in - `roleGridPermissions` in
 * `SidebarCommunityAdminModal.svelte` - so a positional read of the grid lines up with it.
 */
export const PERMISSION_LABELS = {
  'channel.manage': caption('chat_permission_manage_channel_label'),
  'channel.moderate': caption('chat_permission_moderate_label'),
  'member.invite': caption('chat_permission_invite_label'),
  'member.kick': caption('chat_permission_kick_label'),
  'role.manage': caption('chat_permission_manage_roles_label'),
  'workspace.manage': caption('chat_permission_manage_workspace_label'),
};

/** The key a grid label stands for, or null - the inverse of {@link PERMISSION_LABELS}. */
export function permissionKeyOf(label) {
  return Object.keys(PERMISSION_LABELS).find((k) => PERMISSION_LABELS[k] === label) ?? null;
}
