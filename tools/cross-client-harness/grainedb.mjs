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
import { psql } from './ssh.mjs';

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

/** The uuid of a community by name, or null. Ambiguity answers null rather than picking one. */
export function workspaceIdOf(name) {
  const found = rows(psql(`SELECT id FROM channel_workspaces WHERE name = '${name}'`));
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
