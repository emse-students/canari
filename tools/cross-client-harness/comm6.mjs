/**
 * COMM-6: the permission grid offers the SIX permissions something enforces, and no seventh.
 *
 *   node comm6.mjs
 *
 * THE ROW SAID "A CUSTOM ROLE" AND THE PRODUCT HAS NONE - the fourth row this phase has had to
 * rewrite for naming a mechanism that does not exist. `POST /api/channels/roles` is served, and no
 * client in the repository calls it: the community panel renders the three roles the community is
 * created with and a grid over them, and offers no way to make a fourth. That is recorded here
 * rather than asserted, because a check cannot demand a feature - but it is also not silently
 * dropped, since an endpoint no client can reach is either dead weight or an unbuilt feature and
 * only its owner can say which.
 *
 * WHAT IS LEFT IS THE HALF THAT MATTERS, and it is the half that already went wrong once. The grid
 * had EIGHT rows until 2026-08-19, two of which - `channel.access` and `channel.send` - were read
 * by nothing anywhere in the platform. They were removed rather than wired up, because reading is
 * settled by whether a salon is public or private and writing by its own `writePolicy`, so a
 * per-role switch could only agree with the real rule or contradict it. **A row that cannot change
 * an outcome is worse than a missing one: it reads as a control.** This check is what makes their
 * return loud.
 *
 * READ ON BOTH SIDES, BECAUSE NEITHER ALONE IS EVIDENCE. The grid shows LABELS - localized prose -
 * so a check that only counted rows would keep passing if the key behind a label changed to one
 * nothing enforces; and `channel_roles.permissions` is what every decision actually reads, but a
 * key stored and never offered is a permission nobody can grant. So the SCREEN is asked how many
 * rows it offers and what they are called, the DATABASE is asked what the three roles carry, and a
 * TOGGLE is sent through the grid and looked for in the column - which is the only thing that
 * proves the panel writes rather than draws.
 *
 * THE TOGGLE IS PUT BACK, and the community is deleted anyway: this check builds its own so that a
 * half-applied permission can never outlive it.
 */
import { client, evaluate, until } from './chat.mjs';
import {
  caption,
  communityTab,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  openCommunity,
} from './comm.mjs';
import { communityRoles, workspaceIdOf } from './grainedb.mjs';
import { PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');

const run = mark('COMM6');
const community = `C6 ${run}`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The six the registry enforces, in the order the panel lists them, by the app's own labels. */
const SIX = [
  'chat_permission_manage_channel_label',
  'chat_permission_moderate_label',
  'chat_permission_invite_label',
  'chat_permission_kick_label',
  'chat_permission_manage_roles_label',
  'chat_permission_manage_workspace_label',
].map(caption);

/** The keys those labels stand for - what a decision actually reads. */
const ENFORCED = [
  'channel.manage',
  'channel.moderate',
  'member.invite',
  'member.kick',
  'role.manage',
  'workspace.manage',
];

/**
 * The two that were removed, named here so their return is a failure rather than a bigger number.
 *
 * Their captions are gone from `fr.json`, so they cannot be looked for on the screen at all -
 * `caption()` would throw. The stored keys are where they would come back, which is also where
 * migration `044` cleared them from.
 */
const RETIRED = ['channel.access', 'channel.send'];

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
async function grid(cx) {
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
         return { permissions: permissions, roles: roles, adminLocked: lockedColumn };
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
async function cycleCell(cx, label, column) {
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
  if (outcome !== 'clicked') throw new Error(`cycleCell(${label}, ${column}): ${outcome}`);
}

/** Waits for the stored permissions of one role to satisfy `predicate`, and reports what it saw. */
async function roleSettles(workspaceId, roleName, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const role = communityRoles(workspaceId).find((r) => r.name === roleName);
    if (role && predicate(role.permissions)) return role.permissions;
    if (Date.now() > deadline) return role ? role.permissions : null;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// -- A community of its own, with the three roles it is created with -------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

const shown = await step('read the permission grid', async () => {
  await communityTab(w1, 'roles');
  // THE TAB FETCHES ITS ROLES. `communityTab` returns on the click, and the panel renders a spinner
  // until `GET roles` answers - so a read taken straight after finds no table at all and reports
  // "the grid offers nothing", which is an instrument describing itself. The first run of this
  // check did exactly that.
  await until(w1, `!!document.querySelector('table tbody tr')`, 20000);
  return grid(w1);
});

const stored = workspaceId ? communityRoles(workspaceId) : [];
const moderator = stored.find((r) => r.priority === 50) ?? null;
const admin = stored.find((r) => r.priority >= 100) ?? null;
const member = stored.find((r) => r.priority < 50) ?? null;

// Nothing below is worth reading unless the community really has its three roles and the panel
// really drew a grid.
const armed = !!workspaceId && Array.isArray(shown?.permissions) && stored.length === 3;

// -- A toggle, so the panel is proven to WRITE and not merely to draw -------------------
//
// The moderator's `channel.moderate` is chosen deliberately: the administrator's column is locked,
// the member's is empty and toggling it would grant rather than revoke - and revoking is the
// direction a stuck panel makes dangerous.
const REVOKED = caption('chat_permission_moderate_label');
const afterRevoke = armed
  ? await step('revoke one permission from the moderator', async () => {
      await cycleCell(w1, REVOKED, 2);
      return roleSettles(workspaceId, moderator.name, (p) => !p.includes('channel.moderate'));
    })
  : null;

const afterRestore =
  armed && afterRevoke && !afterRevoke.includes('channel.moderate')
    ? await step('give it back', async () => {
        // The cell CYCLES, so returning to `allow` may take more than one click: the panel offers
        // allow / neutral / deny and only `disableDeny` removes one of them. Clicked until the
        // column says what it said before, bounded, so a cycle that never returns is a finding.
        for (let i = 0; i < 3; i++) {
          const now = communityRoles(workspaceId).find((r) => r.name === moderator.name);
          if (now?.permissions.includes('channel.moderate')) break;
          await cycleCell(w1, REVOKED, 2);
          await roleSettles(workspaceId, moderator.name, (p) => p.includes('channel.moderate'), 8000);
        }
        return communityRoles(workspaceId).find((r) => r.name === moderator.name)?.permissions ?? null;
      })
    : null;

// -- Its own debris goes -----------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

const expectations = {
  // SIX ROWS, AND THESE SIX. The count alone would pass a grid that renamed one; the labels alone
  // would pass a grid that grew a seventh.
  gridOffersExactlySix: shown?.permissions?.length === 6,
  theSixAreTheOnesEnforced: Array.isArray(shown?.permissions) && sameSet(shown.permissions, SIX),
  // WHERE THE TWO RETIRED ONES WOULD COME BACK. Not on the screen - their captions are gone - but
  // in the column every decision reads.
  noRoleCarriesARetiredPermission: stored.every((r) =>
    r.permissions.every((p) => !RETIRED.includes(p))
  ),
  // The three roles a community is created with, as `permissions.ts` documents them.
  administratorHasEverything: !!admin && sameSet(admin.permissions, ENFORCED),
  moderatorHasTheThree:
    !!moderator &&
    sameSet(moderator.permissions, ['channel.moderate', 'member.invite', 'member.kick']),
  // EMPTY ON PURPOSE, and asserted as such: reading and writing follow from membership and from the
  // salon's own policy, and an empty list is the accurate statement of that.
  memberHasNothing: !!member && member.permissions.length === 0,
  // The panel's own statement that the top role cannot be stripped.
  theAdministratorColumnIsLocked: shown?.adminLocked === true,
  // THE PANEL WRITES. A grid that draws the stored state and sends nothing would pass every
  // assertion above.
  aToggleReachesTheServer: Array.isArray(afterRevoke) && !afterRevoke.includes('channel.moderate'),
  andComesBack: Array.isArray(afterRestore) && afterRestore.includes('channel.moderate'),
};

const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
    ? 'FAIL'
    : 'PASS';

const lines = consoleLines(wa.cx);
const gated = gate(verdict, { W1: await report(wa) });

record('COMM-6', gated.verdict, {
  ...gated.detail,
  community,
  workspaceId,
  armed,
  shown,
  stored,
  afterRevoke,
  afterRestore,
  // NOT AN ASSERTION, A RECORD. `POST /api/channels/roles` exists and no client calls it, so a
  // custom role has no path in the product - which is why this row no longer claims to test one.
  customRoleHasNoPathInTheProduct: true,
  ...expectations,
  failures,
});

console.log(`\n===== W1: ${lines.length} console lines =====`);
for (const l of lines) console.log(`  ${l}`);

w1.close();
