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
  const found = rows(psql(`SELECT id FROM users WHERE "displayName" = '${displayName}'`));
  return found.length === 1 ? found[0][0] : null;
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
