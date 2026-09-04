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
 *   bun newgroup.mjs --port 9223 --name HEALW2-xxxx [--add "<the other party's display name>"]
 */
import { APP_TAB, client, evaluate, realClick, until } from './chat.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);

const cx = await client(Number(arg('port', 9223)), APP_TAB, { focus: false });
const name = arg('name', `HEALW2-${Date.now().toString(36)}`);
const addWho = arg('add', null);

// THE GESTURE ITSELF NOW LIVES IN `groupnav.mjs`, and all three hard-won post-conditions written out
// here went with it: close a leftover overlay by its own control (Escape does NOT close this modal),
// assert "Creer le groupe" is enabled before clicking it (a click on a disabled control is discarded
// in silence), and wait for the SIDEBAR ROW rather than the composer (creating a group re-sorts the
// list and can lose the selection). All three were correct here and absent from `del1.mjs` and
// READ-10 - which is the whole argument for there being one copy.
//
// What stays HERE is what this script is FOR: reporting the surface that adds a member to a group,
// which HEAL-W1 needs and no other caller wants.
const { createGroup } = await import('./groupnav.mjs');
await createGroup(cx, name, { label: 'newgroup' });
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
