/**
 * THE SOCIAL HALF OF AN ACCOUNT ERASURE, AS DATA: what happens to every column that can name an
 * account, and the statements that do it.
 *
 * core-service's durable erasure queue calls `DELETE internal/users/:userId` until it answers 2xx,
 * then once more after every token the account held has expired (`account-erasure.service.ts`
 * there). So everything here is IDEMPOTENT - a second run finds nothing and changes nothing - and
 * runs in ONE transaction, so a failure leaves nothing half-done for the retry to miss.
 *
 * THE COVERAGE MAP IS ASSERTED AGAINST THE SCHEMA (`account-erasure.coverage.spec.ts`): every
 * entity property whose name says it holds an account id (`libs/contracts/
 * account-reference-columns.json`) must have a disposition here, and every `delete`/`anonymise`
 * must be carried out by a statement that names its column. The hand-written list this replaced
 * forgot comments, reactions and poll votes left on other people's posts, form answers, reminders,
 * notifications, minesweeper, reviewer grants and a dozen authorship columns - nothing compared it
 * with the schema.
 *
 * The reasoning per decision is on docs/wiki/account-erasure.md.
 */

/** The account id written in place of an erased one. Read as "a deleted account" by every client. */
export const DELETED_ACCOUNT = '[deleted]';

/**
 * `delete` - the rows go. `anonymise` - the row stays (it also belongs to other people, or is an
 * accounting record) and the id becomes {@link DELETED_ACCOUNT}, or NULL where the column allows
 * it. `kept` - deliberately untouched, with the reason. `via` names the column whose statement
 * carries this one out when it is not the column itself (a name deleted with its row).
 */
export type ErasureDisposition =
  | { action: 'delete'; via?: string }
  | { action: 'anonymise'; via?: string }
  | { action: 'kept'; reason: string }
  | { action: 'code'; by: string };

/** `table.column` -> what the erasure does to it. */
export const ACCOUNT_ERASURE_COVERAGE: Record<string, ErasureDisposition> = {
  // -- The account's own content and standing: deleted ------------------------------------------
  'posts.authorId': { action: 'delete' },
  'association_members.userId': { action: 'delete' },
  'association_role_history.user_id': { action: 'delete' },
  'user_follows.followerUserId': { action: 'delete' },
  'user_follows.followedUserId': { action: 'delete' },
  'association_follows.followerUserId': { action: 'delete' },
  'association_push_mutes.userId': { action: 'delete' },
  'user_tags.userId': { action: 'delete' },
  'user_moderation.userId': { action: 'delete' },
  'form_respondents.userId': { action: 'delete' },
  'form_reminders.userId': { action: 'delete' },
  'post_notifications.recipientId': { action: 'delete' },
  'post_notifications.actorId': { action: 'delete' },
  'post_notifications.actorName': { action: 'delete', via: 'actorId' },
  'minesweeper_scores.userId': { action: 'delete' },
  'minesweeper_challenges.userId': { action: 'delete' },
  'minesweeper_bans.userId': { action: 'delete' },
  'document_reviewer_grants.userId': { action: 'delete' },
  'read_grants.user_id': { action: 'delete' },
  // The claim already turned the legacy row into a `user_tags` row (deleted above); what is left is
  // the name it was matched on, which is the last nominative trace.
  'legacy_cotisations.claimedByUserId': { action: 'delete' },
  'channel_members.userId': {
    action: 'code',
    by: 'ChannelService.removeAccountFromWorkspaces (governance repair before each removal)',
  },

  // -- Rows that belong to other people too, or are accounting records: anonymised -------------
  'channel_messages.authorId': { action: 'anonymise' },
  'channel_messages.senderSessionId': { action: 'anonymise', via: 'authorId' },
  'purchase_records.userId': { action: 'anonymise' },
  'webhook_deliveries.userId': { action: 'anonymise' },
  'submissions.userId': { action: 'anonymise' },
  'submissions.email': { action: 'anonymise', via: 'userId' },
  'submissions.answers': { action: 'anonymise', via: 'userId' },
  'submissions.paymentSettledBy': { action: 'anonymise' },
  'form_files.uploaderId': { action: 'anonymise' },
  'forms.ownerId': { action: 'anonymise' },
  // A consumed code must stay consumed: NULL would hand it to the next student.
  'partnership_codes.claimedByUserId': { action: 'anonymise' },
  'content_reports.reporterId': { action: 'anonymise' },
  'content_reports.reviewedBy': { action: 'anonymise' },
  'content_reports.reportedUserId': { action: 'anonymise' },
  'read_grants.granted_by': { action: 'anonymise' },
  'read_grant_journal.user_id': { action: 'anonymise' },
  'read_grant_journal.actor': { action: 'anonymise' },
  'association_calendar_events.createdBy': { action: 'anonymise' },
  'association_calendar_events.validatedBy': { action: 'anonymise' },
  'association_calendar_events.rejectedBy': { action: 'anonymise' },
  'association_documents.uploadedBy': { action: 'anonymise' },
  'associations.createdBy': { action: 'anonymise' },
  'poster_projects.createdBy': { action: 'anonymise' },
  'workspace_invites.createdBy': { action: 'anonymise' },
  'channel_workspaces.createdBy': { action: 'anonymise' },
  'post_republications.republishedBy': { action: 'anonymise' },
  'proposals.proposedBy': { action: 'anonymise' },
  'proposals.decidedBy': { action: 'anonymise' },
  'user_tags.grantedBy': { action: 'anonymise' },
  'user_moderation.mutedBy': { action: 'anonymise' },
  'document_reviewer_grants.grantedBy': { action: 'anonymise' },
  'minesweeper_bans.bannedBy': { action: 'anonymise' },
  'channels.allowedUsers': { action: 'anonymise' },

  // -- Not an account reference, despite the name ----------------------------------------------
  'associations.contactEmail': {
    action: 'kept',
    reason: "the association's own contact address, written by its officers, not an account's",
  },
  'association_products.maxPurchasesPerUser': {
    action: 'kept',
    reason: 'a per-buyer purchase limit (a number), not an account id',
  },
};

/** A statement of the erasure. `$1` is the erased account id, `$2` is {@link DELETED_ACCOUNT}. */
export interface ErasureStatement {
  /** Short name for the log line. */
  label: string;
  sql: string;
}

/**
 * Every statement, in the order they must run inside ONE transaction. Order matters where a row
 * references another (`minesweeper_scores` before `minesweeper_challenges`), and where a statement
 * reads the column the next one rewrites (the session id is cleared while `authorId` still names
 * the account, the submissions' files before the submissions).
 */
export const ERASURE_STATEMENTS: readonly ErasureStatement[] = [
  // Own content and standing
  { label: 'posts', sql: `DELETE FROM posts WHERE "authorId" = $1` },
  { label: 'association_members', sql: `DELETE FROM association_members WHERE "userId" = $1` },
  { label: 'role_history', sql: `DELETE FROM association_role_history WHERE user_id = $1` },
  {
    label: 'user_follows',
    sql: `DELETE FROM user_follows WHERE "followerUserId" = $1 OR "followedUserId" = $1`,
  },
  {
    label: 'association_follows',
    sql: `DELETE FROM association_follows WHERE "followerUserId" = $1`,
  },
  { label: 'push_mutes', sql: `DELETE FROM association_push_mutes WHERE "userId" = $1` },
  { label: 'user_tags', sql: `DELETE FROM user_tags WHERE "userId" = $1` },
  { label: 'user_moderation', sql: `DELETE FROM user_moderation WHERE "userId" = $1` },
  { label: 'form_respondents', sql: `DELETE FROM form_respondents WHERE "userId" = $1` },
  { label: 'form_reminders', sql: `DELETE FROM form_reminders WHERE "userId" = $1` },
  {
    label: 'post_notifications',
    sql: `DELETE FROM post_notifications WHERE "recipientId" = $1 OR "actorId" = $1`,
  },
  { label: 'minesweeper_scores', sql: `DELETE FROM minesweeper_scores WHERE "userId" = $1` },
  {
    label: 'minesweeper_challenges',
    sql: `DELETE FROM minesweeper_challenges WHERE "userId" = $1`,
  },
  { label: 'minesweeper_bans', sql: `DELETE FROM minesweeper_bans WHERE "userId" = $1` },
  { label: 'reviewer_grants', sql: `DELETE FROM document_reviewer_grants WHERE "userId" = $1` },
  { label: 'read_grants', sql: `DELETE FROM read_grants WHERE user_id = $1` },
  {
    label: 'legacy_cotisations',
    sql: `DELETE FROM legacy_cotisations WHERE "claimedByUserId" = $1`,
  },
  // A report whose entire subject is this account has nothing left to moderate once it is gone.
  {
    label: 'reports_on_account',
    sql: `DELETE FROM content_reports WHERE "contentType" = 'user' AND "contentId" = $1`,
  },

  // Anonymised
  {
    label: 'channel_messages',
    sql: `UPDATE channel_messages SET "senderSessionId" = NULL, "authorId" = $2 WHERE "authorId" = $1`,
  },
  {
    label: 'purchase_records',
    sql: `UPDATE purchase_records SET "userId" = $2 WHERE "userId" = $1`,
  },
  {
    label: 'webhook_deliveries',
    sql: `UPDATE webhook_deliveries SET "userId" = $2 WHERE "userId" = $1`,
  },
  // The answers go, the row stays: it is a seat the form counted and, when paid, a payment record.
  {
    label: 'submissions',
    sql: `UPDATE submissions SET "userId" = NULL, email = NULL, answers = '{}'::jsonb WHERE "userId" = $1`,
  },
  {
    label: 'submissions_settled_by',
    sql: `UPDATE submissions SET "paymentSettledBy" = $2 WHERE "paymentSettledBy" = $1`,
  },
  // A file name is the uploader's words ("CV_Firstname_Lastname.pdf"): it goes with the id.
  {
    label: 'form_files',
    sql: `UPDATE form_files SET "uploaderId" = $2, "fileName" = $2 WHERE "uploaderId" = $1`,
  },
  { label: 'forms', sql: `UPDATE forms SET "ownerId" = $2 WHERE "ownerId" = $1` },
  {
    label: 'partnership_codes',
    sql: `UPDATE partnership_codes SET "claimedByUserId" = $2 WHERE "claimedByUserId" = $1`,
  },
  {
    label: 'reports_reporter',
    sql: `UPDATE content_reports SET "reporterId" = $2 WHERE "reporterId" = $1`,
  },
  {
    label: 'reports_reviewer',
    sql: `UPDATE content_reports SET "reviewedBy" = $2 WHERE "reviewedBy" = $1`,
  },
  {
    label: 'reports_reported',
    sql: `UPDATE content_reports SET "reportedUserId" = $2 WHERE "reportedUserId" = $1`,
  },
  { label: 'read_grants_by', sql: `UPDATE read_grants SET granted_by = $2 WHERE granted_by = $1` },
  {
    label: 'read_grant_journal',
    sql: `UPDATE read_grant_journal SET user_id = $2 WHERE user_id = $1`,
  },
  {
    label: 'read_grant_journal_actor',
    sql: `UPDATE read_grant_journal SET actor = $2 WHERE actor = $1`,
  },
  {
    label: 'calendar_created',
    sql: `UPDATE association_calendar_events SET "createdBy" = $2 WHERE "createdBy" = $1`,
  },
  {
    label: 'calendar_validated',
    sql: `UPDATE association_calendar_events SET "validatedBy" = $2 WHERE "validatedBy" = $1`,
  },
  {
    label: 'calendar_rejected',
    sql: `UPDATE association_calendar_events SET "rejectedBy" = $2 WHERE "rejectedBy" = $1`,
  },
  {
    label: 'documents',
    sql: `UPDATE association_documents SET "uploadedBy" = $2 WHERE "uploadedBy" = $1`,
  },
  { label: 'associations', sql: `UPDATE associations SET "createdBy" = $2 WHERE "createdBy" = $1` },
  {
    label: 'poster_projects',
    sql: `UPDATE poster_projects SET "createdBy" = $2 WHERE "createdBy" = $1`,
  },
  {
    label: 'workspace_invites',
    sql: `UPDATE workspace_invites SET "createdBy" = $2 WHERE "createdBy" = $1`,
  },
  {
    label: 'channel_workspaces',
    sql: `UPDATE channel_workspaces SET "createdBy" = $2 WHERE "createdBy" = $1`,
  },
  {
    label: 'republications',
    sql: `UPDATE post_republications SET "republishedBy" = $2 WHERE "republishedBy" = $1`,
  },
  {
    label: 'proposals_proposed',
    sql: `UPDATE proposals SET "proposedBy" = $2 WHERE "proposedBy" = $1`,
  },
  {
    label: 'proposals_decided',
    sql: `UPDATE proposals SET "decidedBy" = $2 WHERE "decidedBy" = $1`,
  },
  { label: 'tags_granted', sql: `UPDATE user_tags SET "grantedBy" = $2 WHERE "grantedBy" = $1` },
  {
    label: 'moderation_muted',
    sql: `UPDATE user_moderation SET "mutedBy" = $2 WHERE "mutedBy" = $1`,
  },
  {
    label: 'reviewer_granted',
    sql: `UPDATE document_reviewer_grants SET "grantedBy" = $2 WHERE "grantedBy" = $1`,
  },
  {
    label: 'minesweeper_banned',
    sql: `UPDATE minesweeper_bans SET "bannedBy" = $2 WHERE "bannedBy" = $1`,
  },
  // `simple-array`: comma-joined text, ids stored lower-cased (`cutOffEveryPrivateChannel`). The
  // salons of communities the account was still in are cut with their key distribution before
  // this runs; this catches a grant left in any other salon.
  {
    label: 'channel_allowed_users',
    sql: `UPDATE channels
             SET "allowedUsers" = array_to_string(
                   array_remove(string_to_array("allowedUsers", ','), lower($1)), ',')
           WHERE lower($1) = ANY(string_to_array("allowedUsers", ','))`,
  },
];

/**
 * The parameters of one statement. Exactly the ones it uses: PostgreSQL refuses a bind that supplies
 * more parameters than the statement names ("bind message supplies 2 parameters, but prepared
 * statement requires 1"), so a `DELETE` that only names `$1` must not be handed `$2`.
 */
export function erasureParams(statement: ErasureStatement, userId: string): string[] {
  return statement.sql.includes('$2') ? [userId, DELETED_ACCOUNT] : [userId];
}

// -- What the account left on OTHER people's posts, inside the JSONB columns ----------------------

/** A reaction is one key of a map: removed in place, no row needs reading. `$1` is the account. */
export const REMOVE_REACTIONS_SQL = `UPDATE posts SET reactions = reactions - $1 WHERE reactions ? $1`;

/**
 * The posts whose comments or polls may hold the account, read and LOCKED for the scrub. `$1` is
 * {@link jsonStringLikePattern} - a candidate filter only; the scrub functions decide.
 */
export const CANDIDATE_POSTS_SQL = `SELECT id, comments, polls FROM posts
  WHERE comments::text LIKE $1 OR polls::text LIKE $1
  FOR UPDATE`;

/** Writes one scrubbed post back: `$1` id, `$2` comments JSON, `$3` polls JSON. */
export const WRITE_SCRUBBED_POST_SQL = `UPDATE posts SET comments = $2::jsonb, polls = $3::jsonb WHERE id = $1`;

/** A stored comment. The column is `jsonb`, so the shape is open. */
type StoredComment = Record<string, any> & {
  id: string;
  userId?: string;
  parentId?: string | null;
};

/**
 * The comments of one post without the erased account: its own comments are removed, its likes
 * are removed from everyone else's, and a reply to a removed comment is RE-PARENTED to the nearest
 * surviving ancestor (or the top level) rather than deleted - another person's reply is theirs.
 *
 * @returns the new array, and whether anything changed (so an untouched post is not rewritten).
 */
export function scrubComments(
  comments: unknown,
  userId: string
): { comments: unknown; changed: boolean } {
  if (!Array.isArray(comments)) return { comments, changed: false };
  const all = comments as StoredComment[];
  const byId = new Map(all.map((c) => [c.id, c]));
  const removed = new Set(all.filter((c) => c.userId === userId).map((c) => c.id));
  let changed = removed.size > 0;

  const survivingParent = (parentId: string | null | undefined): string | null => {
    let current = parentId ?? null;
    // Bounded by the number of comments, so a cycle in stored data cannot hang the erasure.
    for (let hops = 0; current && removed.has(current) && hops <= all.length; hops++) {
      current = byId.get(current)?.parentId ?? null;
    }
    return current && removed.has(current) ? null : current;
  };

  const kept = all
    .filter((c) => !removed.has(c.id))
    .map((c) => {
      let next = c;
      if (Array.isArray(c.likes) && c.likes.includes(userId)) {
        next = { ...next, likes: c.likes.filter((id: string) => id !== userId) };
        changed = true;
      }
      if (c.parentId && removed.has(c.parentId)) {
        next = { ...next, parentId: survivingParent(c.parentId) };
        changed = true;
      }
      return next;
    });
  return { comments: kept, changed };
}

/**
 * The polls of one post without the erased account's votes.
 *
 * A NAMED poll loses the vote (the tally drops by one): the vote is the account's data and the poll
 * kept who cast it. An ANONYMOUS poll keeps its tally - it never recorded which option was this
 * account's, so nothing can be subtracted - and loses the account from `voters`.
 */
export function scrubPolls(polls: unknown, userId: string): { polls: unknown; changed: boolean } {
  if (!Array.isArray(polls)) return { polls, changed: false };
  let changed = false;
  const next = polls.map((poll: Record<string, any>) => {
    if (!poll || typeof poll !== 'object') return poll;
    let out = poll;
    if (Array.isArray(poll.voters) && poll.voters.includes(userId)) {
      out = { ...out, voters: poll.voters.filter((v: string) => v !== userId) };
      changed = true;
    }
    if (Array.isArray(poll.options)) {
      const options = poll.options.map((o: Record<string, any>) =>
        Array.isArray(o?.votes) && o.votes.includes(userId)
          ? { ...o, votes: o.votes.filter((v: string) => v !== userId) }
          : o
      );
      if (options.some((o: unknown, i: number) => o !== poll.options[i])) {
        out = { ...out, options };
        changed = true;
      }
    }
    if (
      poll.votesByUser &&
      typeof poll.votesByUser === 'object' &&
      Object.prototype.hasOwnProperty.call(poll.votesByUser, userId)
    ) {
      out = {
        ...out,
        votesByUser: Object.fromEntries(
          Object.entries(poll.votesByUser).filter(([voter]) => voter !== userId)
        ),
      };
      changed = true;
    }
    return out;
  });
  return { polls: next, changed };
}

/**
 * The LIKE pattern that finds every post whose comments or polls mention the account as a JSON
 * string - a candidate filter only, the scrub functions decide. LIKE metacharacters in the id are
 * escaped so an id can never widen the match.
 */
export function jsonStringLikePattern(userId: string): string {
  return `%"${userId.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
}
