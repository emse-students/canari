/**
 * Creates a group conversation, and reports the surface that adds a member to it.
 *
 * HEAL-W2 needs a group that did NOT exist when the snapshot was taken: the web MLS state is one
 * opaque blob (`mls_autosave`, 1.7 MB), so no edit can make a single existing group unknown - the
 * break has to be constructed as snapshot -> create -> restore.
 *
 * The venue rule still applies. A group whose only members are the two test accounts IS the
 * two-test-account venue, which is why this creates one rather than touching a channel any real
 * association can read.
 *
 * The "Groupe" tab takes a NAME ONLY and creates the group empty, so adding the peer is a second,
 * separate step - and that step is a membership commit, which is what HEAL-W1 needs. Reporting the
 * surface here is therefore part of the job, not a debugging aid.
 *
 *   node newgroup.mjs --port 9223 --name HEALW2-xxxx [--add "<the other party's display name>"]
 */
import { client, evaluate, realClick, until } from './chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);

const cx = await client(Number(arg('port', 9223)), 'canari-emse.fr', { focus: false });
const name = arg('name', `HEALW2-${Date.now().toString(36)}`);
const addWho = arg('add', null);

/**
 * Closes the dialog if one is open, by its OWN control.
 *
 * Escape was tried first and does not close this modal - which is worth stating rather than
 * silently working around: a check that assumed it did would leave the dialog up and every later
 * click would fail with "no stable element" for a control that is plainly in the DOM. The dialog
 * ships a "Fermer" button, so use that and assert it worked.
 */
const closeDialog = async () => {
  const open = await evaluate(cx, `!!document.querySelector('#new-group-name') || /Nouvelle discussion Contact Groupe/.test(document.body.innerText.replace(/\\s+/g, ' '))`);
  if (!open) return 'already closed';
  await realClick(cx, 'text=Fermer');
  await sleep(1200);
  const still = await evaluate(cx, `!!document.querySelector('#new-group-name')`);
  if (still) throw new Error('the new-conversation dialog would not close');
  return 'closed';
};

// A modal left open by an earlier step hides the trigger, which presents as "no stable element"
// for a control that is plainly in the DOM. Always start from a closed dialog.
console.log(`[newgroup] dialog: ${await closeDialog()}`);
if ((await evaluate(cx, 'location.pathname')) !== '/chat') {
  await evaluate(cx, `location.href = '/chat'`);
  await sleep(5000);
}

await realClick(cx, '[aria-label="Nouvelle discussion"]');
await sleep(1500);
await realClick(cx, 'text=Groupe');
await sleep(1000);
await realClick(cx, '#new-group-name');
await cx.send('Input.insertText', { text: name });
await sleep(600);

// POST-CONDITION before the click: "Créer le groupe" is disabled until the name lands, and a click
// on a disabled control is discarded in silence - the same race `send` documents for the composer.
const ready = await evaluate(
  cx,
  `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /Créer le groupe/.test(x.innerText || ''); })[0];
    return b ? !b.disabled : null;
  })()`
);
if (!ready) throw new Error(`"Créer le groupe" still disabled after typing the name (ready=${ready})`);

await realClick(cx, 'text=Créer le groupe');

// THE POST-CONDITION IS THE SIDEBAR ROW, NOT THE COMPOSER.
//
// Creating a group sometimes leaves it open and sometimes does not - with several conversations in
// the list it re-sorts and the selection is lost - so waiting for the composer made this script
// fail on a group it had just created successfully. Wait for the thing that is actually implied by
// "the group exists", and let the caller decide to open it.
await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) !== -1`, 25000);
await sleep(2500);
console.log(`[newgroup] created "${name}" (present in the list)`);

// The member surfaces live on the group PANE, which may not be open (see above), so this is a
// report rather than an assertion - `invite.mjs` opens the group itself and owns that step.
const surfaces = JSON.parse(
  await evaluate(
    cx,
    `JSON.stringify([].slice.call(document.querySelectorAll('button, [role=button]')).map(function (b) {
      return { t: ((b.innerText || '').trim() || (b.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').slice(0, 50) };
    }).filter(function (x) { return x.t && /ajout|membre|participant|inviter|\\+|param|info|gérer|gerer/i.test(x.t); }))`
  )
);
console.log(`[newgroup] member surfaces on the group pane: ${JSON.stringify(surfaces)}`);
console.log(`[newgroup] pane: ${(await evaluate(cx, 'document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)')).slice(0, 400)}`);

if (addWho) console.log(`[newgroup] --add ${addWho} requested; use the surface above (not yet automated)`);

cx.close();
process.exit(0);
