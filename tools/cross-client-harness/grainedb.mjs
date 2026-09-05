/**
 * The three questions the COMM phase cannot ask a SCREEN, asked of production's database instead.
 *
 * WHY THE DATABASE AT ALL, in a phase that is otherwise about what a person sees. Since 2026-08-20 a
 * private salon's seeds travel on a group of its own, whose roster is the salon's members - so the
 * guarantee under test is what a device is **no longer SENT**. A screen cannot show that. A member
 * excluded from a salon sees an empty sidebar entry whether they were denied the ciphertext, denied
 * the seed, or simply never told the salon exists, and those are three different mechanisms with
 * three different failures. `docs/wiki/testing-methodology.md` calls this reading the store rather
 * than the screen, and it is the same reason `recon.mjs` exists.
 *
 * READ-ONLY, ALWAYS. Nothing here writes: a check that repairs the state it is measuring measures
 * the repair. Every query is a single `SELECT` through `ssh.psql`, tuples-only and unaligned, so an
 * empty result is an empty string and never a header.
 *
 * IDS, NOT NAMES. The salon is named by its uuid because that is what every table joins on; the
 * caller gets it from `channelIdOf`, which is the one place a display name is turned into one.
 */
import { pollFact } from './chat.mjs';
import { psql } from './estate.mjs';

/** Splits psql's tuples-only output into rows of fields, dropping the trailing blank line. */
const rows = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split('|'));

/**
 * The uuid of a channel by name, within one community, or null.
 *
 * Names carry a run marker in this phase, so a name is unique by construction - but the community
 * is still named, because a check that matched a salon in ANOTHER community would report a perfect
 * exclusion for a group nobody under test can see.
 */
export function channelIdOf(workspaceId, name) {
  const out = psql(
    `SELECT id FROM channels WHERE "workspaceId" = '${workspaceId}' AND name = '${name}'`
  );
  const found = rows(out);
  return found.length === 1 ? found[0][0] : null;
}

/**
 * The uuid of a community by name, or null. Ambiguity answers null rather than picking one.
 *
 * **A NAME IDENTIFIES A COMMUNITY ONLY WHERE THE POPULATION MAKES IT UNIQUE, AND SINCE 2026-09-03
 * THIS RIG RUNS ON A COPY OF PRODUCTION.** The name was a sufficient key for exactly as long as the
 * campaign was the only thing on the estate using it. It stopped being one the day the local
 * database was seeded from a production dump: `Campagne de test` resolved to a real community that
 * two real members own, the campaign's own accounts were in nothing at all, and `venue.mjs` took
 * that id for its fixture and went on to invite a peer into a community its client cannot even
 * list. What it reported was `the community was never listed within 20000ms` - which reads as a
 * SIDEBAR defect, and was an identity mismatch that one `channel_members` row settles before any
 * gesture is attempted.
 *
 * `memberUserId` scopes the question to "a community by this name THAT THIS ACCOUNT IS IN". Both
 * questions are real and the caller picks between them rather than falling back: unscoped answers
 * "is this name taken at all", which is what DIAGNOSES a collision, and scoped answers "is this
 * one OURS", which is what a fixture guard has always meant.
 */
export function workspaceIdOf(name, { memberUserId = null } = {}) {
  // EXISTS rather than a join: a member holding two rows would otherwise duplicate the community
  // and trip the ambiguity guard below, reporting "no such community" for one plainly there.
  const mine = memberUserId
    ? ` AND EXISTS (SELECT 1 FROM channel_members m WHERE m."workspaceId" = w.id ` +
      `AND m."userId" = '${memberUserId}')`
    : '';
  const found = rows(psql(`SELECT w.id FROM channel_workspaces w WHERE w.name = '${name}'${mine}`));
  return found.length === 1 ? found[0][0] : null;
}

/**
 * What the server holds for a salon's own key distribution: the group, its epoch, its roster.
 *
 * `group` is null when the salon has none, which is the CORRECT state for a public salon and a
 * fault for a private one - the caller knows which it asked about, and this does not guess.
 *
 * `retired` distinguishes a tombstoned group from an absent one, and the two must never be merged:
 * a salon turned public should have a group that is retired AND unlinked, while a salon that never
 * had one should have nothing at all.
 *
 * `devices` is the DELIVERY roster - `dm_device_group_memberships` - which is what a seed frame is
 * actually fanned out to. It is the answer to "was this person's device sent the seed", and the
 * only one there is.
 */
export function salonDistribution(channelId) {
  const meta = rows(
    psql(
      `SELECT c."isPrivate", coalesce(c."distributionGroupId"::text,''), ` +
        `coalesce(d.id::text,''), coalesce(d."activeEpoch"::text,''), ` +
        `CASE WHEN d."deletedAt" IS NULL THEN 'live' ELSE 'retired' END, ` +
        `coalesce(c."allowedUsers",'') ` +
        `FROM channels c LEFT JOIN dm_groups d ON d.id = c."distributionGroupId" ` +
        `WHERE c.id = '${channelId}'`
    )
  );
  if (meta.length !== 1) return null;
  const [isPrivate, linkedGroup, groupId, epoch, life, allowed] = meta[0];
  const devices = groupId
    ? rows(
        psql(
          `SELECT "userId", "deviceId", status FROM dm_device_group_memberships ` +
            `WHERE "groupId" = '${groupId}' ORDER BY "userId", "deviceId"`
        )
      ).map(([userId, deviceId, status]) => ({ userId, deviceId, status }))
    : [];
  return {
    isPrivate: isPrivate === 't',
    // Linked and live are separate facts: retirement clears the link, and a link surviving a
    // retirement is exactly the leftover the 2026-08-20 fix removed.
    linkedGroupId: linkedGroup || null,
    groupId: groupId || null,
    epoch: epoch ? Number(epoch) : null,
    retired: life === 'retired',
    // A TEXT COLUMN, comma-separated, NOT a Postgres array - so an empty roster is the empty
    // string and `''.split(',')` would report one member named nothing.
    allowedUsers: allowed ? allowed.split(',') : [],
    devices,
  };
}

/**
 * Waits until a user's devices either HOLD or do not hold delivery rows on a salon's own group.
 *
 * THE DELIVERY ROSTER IS THE POST-CONDITION OF EVERY MEMBERSHIP GESTURE, and it is the only thing
 * that is: a grant is entitlement and a revoke is an intention, while `dm_device_group_memberships`
 * is what a seed frame is actually fanned out to. Polling it turns each gesture into an assertion -
 * a gesture that carries on without the roster having moved is one that mints no session, and a
 * sleep in this place could not tell that apart from a slow one.
 *
 * IT DOES NOT MATTER WHOSE MEMBERSHIP IT IS, which is why this is not the peer's helper it started
 * as. THE MEMBER COMMITS ITS OWN ADD, so the gesture that moves the roster is that member LOADING
 * the salon - as true of the owner granting itself on a flip to private (COMM-23) as of a peer being
 * granted (COMM-22). Neither caller may assume the grant alone did anything.
 *
 * A DEADLINE IS A RESULT, NEVER A THROW, per `pollFact`: only the caller knows whether a roster that
 * never settled is the product's answer or its own missing gesture.
 *
 * @param {string} channelId the salon
 * @param {string} userId whose devices to look for; matched case-insensitively
 * @param {boolean} wanted whether they should be on the roster by the end
 * @returns {Promise<{ok: boolean, elapsedMs: number, dist: ReturnType<typeof salonDistribution>}>}
 */
export async function awaitUserRouting(channelId, userId, wanted, timeoutMs = 60_000) {
  if (!channelId || !userId) throw new Error('awaitUserRouting needs a salon and a user');
  const mine = userId.toLowerCase();
  let dist = null;
  const outcome = await pollFact(
    () => {
      dist = salonDistribution(channelId);
      return (dist?.devices ?? []).some((d) => d.userId.toLowerCase() === mine) === wanted;
    },
    { timeoutMs, everyMs: 2000 }
  );
  return { ok: outcome.ok, elapsedMs: outcome.elapsedMs, dist };
}

/**
 * The community's own distribution group and its delivery roster, for the comparison that gives a
 * salon result its meaning.
 *
 * A salon roster of one proves nothing on its own - it could be a salon nobody joined, or a
 * community nobody joined. Read next to a community roster of three it says what COMM-8 asks: the
 * seed reached the salon's member and no one else, while everyone remained on the community's.
 */
export function communityDistribution(workspaceId) {
  const found = rows(
    psql(
      `SELECT id, "activeEpoch" FROM dm_groups ` +
        `WHERE "distributionWorkspaceId" = '${workspaceId}' AND "deletedAt" IS NULL`
    )
  );
  if (found.length !== 1) return null;
  const [groupId, epoch] = found[0];
  const devices = rows(
    psql(
      `SELECT "userId", "deviceId", status FROM dm_device_group_memberships ` +
        `WHERE "groupId" = '${groupId}' ORDER BY "userId", "deviceId"`
    )
  ).map(([userId, deviceId, status]) => ({ userId, deviceId, status }));
  return { groupId, epoch: Number(epoch), devices };
}

/**
 * Waits until a user's devices either HOLD or do not hold delivery rows on the COMMUNITY's own
 * distribution group - the sibling of `awaitUserRouting`, one level up.
 *
 * A COMMUNITY'S ROSTER IS WHAT A PUBLIC SALON DELIVERS ON, and that is why this exists separately.
 * A public salon carries no group of its own (`salonDistribution` answers null for one, correctly),
 * so `awaitUserRouting` has nothing to poll there and a caller reaching for it on `general` would
 * read "no roster" as "not routed" for ever. The community group is the one that fans a public
 * salon's frames out, so it is the roster a member of a public salon has to appear on.
 *
 * AN INVITATION DOES NOT MOVE IT. Membership is entitlement; the delivery row is minted when THE
 * MEMBER'S OWN DEVICE commits its add, which happens when that member LOADS the community. So a
 * fixture is not usable the moment the invite lands - measured 2026-09-04, when a freshly built
 * venue carried the owner's single device and nothing else, and a peer invited seconds earlier was
 * absent from the only roster its messages would travel on.
 *
 * A DEADLINE IS A RESULT, NEVER A THROW, exactly as in `awaitUserRouting`: only the caller knows
 * whether a roster that never settled is the product's answer or its own missing gesture.
 *
 * @param {string} workspaceId the community
 * @param {string} userId whose devices to look for; matched case-insensitively
 * @param {boolean} wanted whether they should be on the roster by the end
 * @returns {Promise<{ok, elapsedMs, dist: ReturnType<typeof communityDistribution>}>}
 */
export async function awaitCommunityRouting(workspaceId, userId, wanted, timeoutMs = 10_000) {
  if (!workspaceId || !userId) throw new Error('awaitCommunityRouting needs a community + user');
  const mine = userId.toLowerCase();
  let dist = null;
  const outcome = await pollFact(
    () => {
      dist = communityDistribution(workspaceId);
      return (dist?.devices ?? []).some((d) => d.userId.toLowerCase() === mine) === wanted;
    },
    { timeoutMs, everyMs: 1000 }
  );
  return { ok: outcome.ok, elapsedMs: outcome.elapsedMs, dist };
}

/** The user id behind a display name, or null. Used to name a device roster's rows. */
export function userIdOf(displayName) {
  const exact = rows(psql(`SELECT id FROM users WHERE "displayName" = '${displayName}'`));
  if (exact.length === 1) return exact[0][0];

  // THE NAMES THE HARNESS HOLDS ARE THE ONES THE UI IS MATCHED WITH, and the UI is matched on a
  // SUBSTRING (`[aria-label*=...]`) - so a first name alone is a perfectly good handle there and
  // matched nothing at all here. It returned null silently, and the query built from it asked the
  // database about the user literally named "null", which is a diagnosis of the app for a lookup
  // that never happened.
  //
  // Widened to a prefix, and AMBIGUITY STILL ANSWERS NULL: two accounts sharing a first name must
  // not be resolved by whichever row the planner returns first. That is the same rule the exact
  // branch obeys, applied to a wider net rather than relaxed.
  const prefixed = rows(psql(`SELECT id FROM users WHERE "displayName" LIKE '${displayName}%'`));
  return prefixed.length === 1 ? prefixed[0][0] : null;
}

/**
 * How many messages a salon holds - the only way to assert an ABSENCE in its transcript.
 *
 * COMM-13 needs it: an admin joining a private salon must leave NO system message, and "there is no
 * line about it on screen" is a statement about scrolling, not about the transcript.
 */
export function messageCount(channelId) {
  const found = rows(psql(`SELECT count(*) FROM channel_messages WHERE "channelId" = '${channelId}'`));
  return found.length === 1 ? Number(found[0][0]) : null;
}

/**
 * The Graine SESSIONS a salon's transcript was sealed under, and how many rows each one holds.
 *
 * A SESSION IS THE UNIT THAT ROTATES, AND A MESSAGE COUNT CANNOT SEE IT. `messageCount` answers how
 * much was said; this answers how many separate seeds a reader has to hold to read it, which is the
 * quantity COMM-22 is about: rotation is per (channel, sender) on departure, 100 messages or 7 days,
 * so a salon whose roster has churned holds many sessions over very few messages. A check that
 * counted messages would report a busy salon as a hard one and a churned one as easy - the exact
 * inversion of what costs a device work.
 *
 * Read from the SERVER because it is the only complete list: a device holds the sessions it was
 * given, which is the very thing under test, so asking a client would be asking the subject.
 *
 * @returns `[{ sessionId, messages, authorId }]`, busiest first, or `[]` for an empty salon.
 */
export function channelSessions(channelId) {
  return rows(
    psql(
      `SELECT "senderSessionId", count(*), max("authorId") ` +
        `FROM channel_messages WHERE "channelId" = '${channelId}' ` +
        `AND "senderSessionId" IS NOT NULL ` +
        `GROUP BY "senderSessionId" ORDER BY count(*) DESC`
    )
  ).map(([sessionId, messages, authorId]) => ({
    sessionId,
    messages: Number(messages),
    authorId,
  }));
}

/**
 * A group looked up BY ID, so a check can follow one the salon has stopped pointing at.
 *
 * COMM-24 needs it and nothing else can give it: retirement clears `channels.distributionGroupId`,
 * so a join from the salon finds nothing and the group's death becomes unobservable from the salon's
 * side. The three facts retirement produces have to be asserted separately - the salon lets go, the
 * group dies, the scope is released - because merging any two of them is what hid a defect until
 * 2026-08-20: a tombstone still holding its scope was handed straight back the next time the salon
 * went private.
 *
 * @returns `{ retired, scope }` where `scope` is `null` once released - or null if there is no row.
 */
export function groupState(groupId) {
  const found = rows(
    psql(
      `SELECT CASE WHEN "deletedAt" IS NULL THEN 'live' ELSE 'retired' END, ` +
        `coalesce("distributionWorkspaceId"::text,''), coalesce("distributionChannelId"::text,'') ` +
        `FROM dm_groups WHERE id = '${groupId}'`
    )
  );
  if (found.length !== 1) return null;
  const [life, ws, chan] = found[0];
  return { retired: life === 'retired', scope: ws || chan || null };
}

/**
 * A member's community role AS THE SERVER HOLDS IT: `admin`, `moderator`, `member`, or null.
 *
 * WHY NOT READ THE SCREEN. The modal shows an admin a `<select>` whose value is the role and shows
 * everybody else a translated badge - so a check asserting on the screen alone is asserting on
 * `fr.json` and on which client happened to be looking. This is the row the permission checks
 * actually consult, so it is the only thing that can say a promotion TOOK EFFECT rather than merely
 * having been displayed.
 *
 * THE STORED NAMES ARE FRENCH, and that is not an oversight to work around: `channel_roles.name`
 * holds `Administrateur` / `Moderateur` / `Membre`, and social-service's own
 * `normalizeRoleLabelToCanonical` folds them to the three canonical values. The same fold is done
 * here, accent-insensitively, so this answers in the vocabulary every check is written in.
 *
 * `roleIds` is a TypeORM `simple-array`, i.e. one comma-separated text column, so the join is a
 * substring test rather than an array containment - `array_to_string` on it is a type error, which
 * is how this was learned. Ordered by priority, and the HIGHEST is returned: holding both `Membre`
 * and `Administrateur` is administrator, exactly as the permission check reads it.
 */
export function communityRole(workspaceId, userId) {
  const out = psql(
    `SELECT r.name, r.priority FROM channel_members m ` +
      `JOIN channel_roles r ON r."workspaceId" = m."workspaceId" ` +
      `WHERE m."workspaceId" = '${workspaceId}' AND m."userId" = '${userId}' ` +
      `AND position(r.id::text in m."roleIds") > 0 ORDER BY r.priority DESC`
  );
  const found = rows(out);
  if (found.length === 0) return null;

  const canonical = (name) => {
    const n = String(name)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    if (n === 'administrateur' || n === 'administrator' || n === 'admin') return 'admin';
    if (n === 'moderateur' || n === 'moderator') return 'moderator';
    return 'member';
  };
  // Highest priority first, and the first canonical value that is not the default wins: a member
  // row that still carries `Membre` alongside a promotion must not read as a demotion.
  for (const [name] of found) {
    const role = canonical(name);
    if (role !== 'member') return role;
  }
  return 'member';
}

/**
 * Whether a user is a member of a community at all - `channel_members` alone, no role.
 *
 * SEPARATE FROM {@link communityRole} because "no row" and "a row with no recognised role" are two
 * different states and a check about removal must not accept the second for the first. A removal
 * that left the row behind with its roles stripped would read as `member` here and as gone there.
 */
export function isCommunityMember(workspaceId, userId) {
  const found = rows(
    psql(
      `SELECT 1 FROM channel_members WHERE "workspaceId" = '${workspaceId}' AND "userId" = '${userId}'`
    )
  );
  return found.length > 0;
}

/**
 * Every user id holding a membership row in a community, oldest first.
 *
 * NAMED FOR ITS IDS, because `comm.mjs` exports a `communityMembers` that reads the MEMBERS PANEL on
 * a client. Two readers of "the members" answering from a screen and from a table would be one
 * import line away from being mistaken for each other.
 *
 * THE ROSTER, NOT A YES/NO, and it is separate from {@link isCommunityMember} because that one can
 * only answer about an id the caller already holds IN FULL. The preflight holds PREFIXES: the
 * gateway names each client by a truncated user id and nothing else on the rig knows the whole one,
 * so the only question it can ask is "is one of these in the roster", which needs the roster.
 */
export function communityMemberIds(workspaceId) {
  return rows(
    psql(
      `SELECT "userId" FROM channel_members WHERE "workspaceId" = '${workspaceId}' ORDER BY "createdAt"`
    )
  ).map(([userId]) => userId);
}

/**
 * Everything a community owns, counted per table - what a DELETE must leave at zero.
 *
 * COUNTED RATHER THAN LOOKED AT. Deletion became a real delete on 2026-08-18, and "the sidebar
 * entry is gone" is a statement about one client's cache: the rows are what decides whether the
 * name is free again, whether a member still has a membership row pointing at nothing, and whether
 * the key-distribution group was retired or merely abandoned.
 *
 * `slug` is returned SEPARATELY from the counts because it answers a different question - not "is
 * it gone" but "may the next community have this name". A slug held by a row that no longer exists
 * is exactly the state the old soft delete left behind.
 */
export function workspaceFootprint(workspaceId) {
  const one = (sql) => {
    const found = rows(psql(sql));
    return found.length ? Number(found[0][0]) : 0;
  };
  const slugRows = rows(psql(`SELECT slug FROM channel_workspaces WHERE id = '${workspaceId}'`));
  return {
    workspace: slugRows.length,
    slug: slugRows.length ? slugRows[0][0] : null,
    channels: one(`SELECT count(*) FROM channels WHERE "workspaceId" = '${workspaceId}'`),
    members: one(`SELECT count(*) FROM channel_members WHERE "workspaceId" = '${workspaceId}'`),
    roles: one(`SELECT count(*) FROM channel_roles WHERE "workspaceId" = '${workspaceId}'`),
    invites: one(`SELECT count(*) FROM workspace_invites WHERE "workspaceId" = '${workspaceId}'`),
    // Live key-distribution groups still claiming this community or one of its salons. A retired
    // group releases its scope, so a surviving CLAIM - not a surviving row - is the fault.
    liveDistributionGroups: one(
      `SELECT count(*) FROM dm_groups WHERE "distributionWorkspaceId" = '${workspaceId}' AND "deletedAt" IS NULL`
    ),
  };
}

/** Whether any community currently holds `slug`. The question "is the name free again". */
export function slugTaken(slug) {
  return rows(psql(`SELECT id FROM channel_workspaces WHERE slug = '${slug}'`)).length > 0;
}

/**
 * Whether a channel row still exists at all, by id.
 *
 * IT ANSWERED `true` FOREVER UNTIL 2026-08-20, and the check that asked was right: `DELETE
 * /channels/:id` set `archived = true` while destroying the salon's key-distribution group, so the
 * row survived as ciphertext nothing could open. COMM-16 failed on exactly this question, was
 * nearly "fixed" to ask a softer one, and was the only thing that noticed. The server now deletes.
 */
export function channelExists(channelId) {
  return rows(psql(`SELECT id FROM channels WHERE id = '${channelId}'`)).length > 0;
}

/** How many messages still name this channel - the rows a delete has to take with it. */
export function channelMessageCount(channelId) {
  const found = rows(
    psql(`SELECT count(*) FROM channel_messages WHERE "channelId" = '${channelId}'`)
  );
  return found.length ? Number(found[0][0]) : 0;
}

/**
 * What the community stores as its history rule for newcomers - `'shared'` or `'joined'`.
 *
 * READ FROM THE TABLE BECAUSE THE SETTING IS NOT WHERE IT IS APPLIED. The server stores this column
 * and can do nothing with it: it holds no seed, so the rule is carried out by whichever MEMBER's
 * device answers a newcomer's history request. That split is the reason a check has to read both
 * ends - the column proves the intent was recorded, and only the newcomer's screen proves it was
 * honoured. Asserting either one alone measures half a mechanism.
 */
export function historyVisibilityOf(workspaceId) {
  const found = rows(
    psql(`SELECT "historyVisibility" FROM channel_workspaces WHERE id = '${workspaceId}'`)
  );
  return found.length ? found[0][0] : null;
}

/**
 * Who the server believes may WRITE in a salon - `'everyone'`, `'admins_moderators'` or `'admins'`.
 *
 * READ FROM THE TABLE BECAUSE THE PANEL IS THE THING BEING TESTED. A check that saves the setting
 * and then reads it back off the screen it just used is asking the same component twice; the column
 * is the only witness that the save left the browser. And it is the SERVER's copy that decides:
 * `canWriteToChannel` reads this row on every message, so a screen agreeing with it proves nothing
 * a screen disagreeing with it would not have hidden.
 */
export function channelWritePolicy(channelId) {
  const found = rows(
    psql(`SELECT "writePolicy" FROM channels WHERE id = '${channelId}'`)
  );
  return found.length ? found[0][0] : null;
}

/**
 * Every role the community holds, as the server stores it: `[{ name, priority, permissions }]`.
 *
 * THE PERMISSION LIST IS THE THING, and it can only be read here. The grid shows LABELS - localized
 * prose - so a check reading the screen is asserting on `fr.json` and would go on passing if the
 * key behind a label changed to one nothing enforces. That is precisely the failure the two retired
 * permissions were: two rows in a matrix of eight that decided nothing, visible and convincing for
 * a year. What a role GRANTS is `channel_roles.permissions`, which is what `memberHasWorkspacePermission`
 * reads on every decision, and nothing else is evidence.
 *
 * Ordered by priority descending, so the administrator is first whatever it is named.
 */
export function communityRoles(workspaceId) {
  return rows(
    psql(
      // `permissions` is a TypeORM `simple-array`, i.e. ONE text column holding the keys separated
      // by commas - not a Postgres array, so it is selected as it is stored and split here.
      `SELECT name, priority, permissions FROM channel_roles ` +
        `WHERE "workspaceId" = '${workspaceId}' ORDER BY priority DESC`
    )
  ).map(([name, priority, permissions]) => ({
    name,
    priority: Number(priority),
    permissions: permissions ? permissions.split(',').filter(Boolean) : [],
  }));
}

/**
 * The poll messages of a salon, as the SERVER holds them: `[{ id, pinned, poll, content }]`.
 *
 * THE SERVER IS SUPPOSED TO HOLD A POLL WITHOUT HOLDING ITS WORDS, and that is a claim only this
 * side can settle. `metadata.poll` is the tally - option IDS, who voted for which, the deadline -
 * and the question and the labels live in the encrypted body next to it. So the row is returned
 * whole, `content` included, and the check asserts what is NOT in it: a label found anywhere in
 * either column would mean the poll's wording had been handed to the server in clear.
 *
 * `pinned` comes back because auto-pinning is part of what a poll IS here (`pinned: pollMeta !==
 * null` on creation, cleared on close), and it is a column no screen states plainly.
 *
 * Ordered oldest first, and every poll of the salon is returned rather than "the" poll: a check
 * that asked for one would have no way to notice a second one appearing.
 */
export function channelPolls(channelId) {
  const out = psql(
    `SELECT row_to_json(t) FROM (` +
      `SELECT id, pinned, metadata->'poll' AS poll, content ` +
      `FROM channel_messages WHERE "channelId" = '${channelId}' ` +
      `AND metadata ? 'poll' ORDER BY "createdAt"` +
      `) t`
  );
  // ONE COLUMN, SO THE ROW SPLITTER IS UNDONE: `rows` cuts on '|', which is a character JSON is
  // perfectly entitled to contain inside a string. Rejoined here rather than parsed field by field.
  return rows(out).map((r) => JSON.parse(r.join('|')));
}

/**
 * The push notification level `userId` has stored for `channelId` - `all`, `mentions`, `none`, or
 * null when the member has never set one.
 *
 * NULL IS NOT `all`, and the difference is the point. The server DEFAULTS an absent entry to `all`
 * (`member.notifLevels?.[channel.id] ?? 'all'`), so a check that folded the two together could not
 * tell "the level was written" from "the level was never written and the default happens to match" -
 * which is exactly the assertion COMM-14 makes about its first gesture.
 *
 * `notifLevels` is a jsonb map keyed by channel id, on the member's ONE row per community: the
 * level is per (member, salon) and the map is where the per-salon part lives.
 */
export function channelNotifLevelOf(workspaceId, channelId, userId) {
  // THE `userId` COLUMN IS THERE TO KEEP THE LINE NON-BLANK, and it is not decoration. Tuples-only
  // psql prints a NULL as an empty field, `rows` drops blank lines, and a member who has never set
  // a level for this salon therefore produced ZERO rows - indistinguishable from not being a member
  // at all. Selecting a column that cannot be null makes the row's existence readable, and the
  // `coalesce` turns "no entry" into a value this function can name.
  const out = psql(
    `SELECT "userId", coalesce("notifLevels"->>'${channelId}', '') FROM channel_members ` +
      `WHERE "workspaceId" = '${workspaceId}' AND "userId" = '${userId}'`
  );
  const found = rows(out);
  if (found.length === 0) {
    throw new Error(`channelNotifLevelOf: ${userId.slice(0, 8)} is not a member of ${workspaceId}`);
  }
  const value = String(found[0][1] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * One user's personal community order, as the SERVER holds it: `[{ workspaceId, name, sortOrder }]`,
 * sorted the way the rail is drawn.
 *
 * THE ORDER IS PER MEMBER, NOT PER COMMUNITY. It lives in `channel_members.sortOrder`, one row per
 * (user, community), which is why this takes a user id and why the same rail can be in two different
 * orders on two accounts without either being wrong. A check that read the community table would be
 * reading a column that does not exist.
 *
 * THE TIE-BREAK IS THE APP'S OWN. `listWorkspacesForUser` sorts on `sortOrder` alone, so rows
 * sharing a value come back in whatever order Postgres liked - which is exactly the state a
 * reorder is supposed to leave behind for the communities it did NOT name. The name is returned
 * beside the id so a caller can compare this against the rail without a second query.
 */
export function workspaceOrderOf(userId) {
  const out = psql(
    `SELECT m."workspaceId", m."sortOrder", w.name FROM channel_members m ` +
      `JOIN channel_workspaces w ON w.id = m."workspaceId" ` +
      `WHERE m."userId" = '${userId}' ORDER BY m."sortOrder" ASC, w.name ASC`
  );
  return rows(out).map(([workspaceId, sortOrder, name]) => ({
    workspaceId,
    sortOrder: Number(sortOrder),
    name,
  }));
}
