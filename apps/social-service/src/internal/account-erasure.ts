/**
 * THE SOCIAL HALF OF AN ACCOUNT ERASURE, AS DATA: what happens to every column that can hold an
 * account id, and the statements that do it.
 *
 * core-service's durable erasure queue calls `DELETE internal/users/:userId` until it answers 2xx,
 * then once more after every token the account held has expired (`account-erasure.service.ts`
 * there). So everything here is IDEMPOTENT - a second run finds nothing and changes nothing - and
 * runs in ONE transaction, so a failure leaves nothing half-done for the retry to miss.
 *
 * THE COVERAGE MAP IS ASSERTED AGAINST THE SCHEMA (`account-erasure.coverage.spec.ts`): every column
 * TypeORM knows (and every migration-only table) whose name says it holds an account id
 * (`libs/contracts/account-reference-columns.json`), or whose type is a container that can carry
 * one (jsonb, simple-array), must have a disposition here, and every `delete`/`anonymise` must be
 * carried out by a statement that names its column. `account-erasure.integration.spec.ts` runs it
 * all against a database built from the entities AND the migrations, unique indexes included.
 *
 * The reasoning per decision is on docs/wiki/account-erasure.md.
 */

/** The account id written in place of an erased one. Read as "a deleted account" by every client. */
export const DELETED_ACCOUNT = '[deleted]';

/**
 * `delete` - the rows go. `anonymise` - the row stays (it also belongs to other people, or is an
 * accounting record) and the id becomes {@link DELETED_ACCOUNT}, or NULL where the column allows
 * it. `kept` - deliberately untouched, with the reason. `code` - carried out by code rather than a
 * statement, named in `by`. `via` names the column whose statement carries this one out when it is
 * not the column itself (a name deleted with its row).
 */
export type ErasureDisposition =
  | { action: 'delete'; via?: string }
  | { action: 'anonymise'; via?: string }
  | { action: 'kept'; reason: string }
  | { action: 'code'; by: string };

const NO_ACCOUNT = (what: string): ErasureDisposition => ({
  action: 'kept',
  reason: `${what} - holds no account id, by what the code writes into it`,
});

/** `table.column` -> what the erasure does to it. */
export const ACCOUNT_ERASURE_COVERAGE: Record<string, ErasureDisposition> = {
  // -- The account's own content and standing: deleted ------------------------------------------
  // A post published AS an association stays (it is the association's communication) and only its
  // author is anonymised - see `posts_association_author`. Every other post of the account goes.
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
  // A form file is its uploader's document: the row goes with the account, and media-service's
  // part of the erasure deletes the blob (class `form-file`, owned by the uploader).
  'form_files.uploaderId': { action: 'delete' },
  'form_files.fileName': { action: 'delete', via: 'uploaderId' },
  // A republication request addressed to the account (D38b): it is about the account's own post,
  // which goes with it, so the request goes too.
  'proposals.toUserId': { action: 'delete' },
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
  // Salon messages (decision 2026-10-16): DELETED, reactions and pinned rows included. Erasure beats
  // continuity, and a row nobody can verify without its author is noise on every remaining
  // member's device - a row with no session asks peers for a seed nobody can send.
  'channel_messages.authorId': { action: 'delete' },
  'channel_messages.senderSessionId': { action: 'delete', via: 'authorId' },
  // The client ids its DELETED salon messages left (migration 090): what keeps a repeated send from
  // posting a removed message again. An erased account repeats no send, so they go with it.
  'channel_message_client_tombstones.authorId': { action: 'delete' },
  // The outbox entry of a salon row (migration 093): its mentions are ids of OTHER accounts, but it
  // lives only until the broadcast and the push are handed off (seconds, or the next boot after a
  // crash), and it cascades with its message - an erased author's messages are deleted below.
  'channel_message_fanout.payload': {
    action: 'kept',
    reason: 'a transient outbox entry, deleted at hand-off and with its message',
  },
  // How the account's key-group departures ended (migration 108). Once the account is gone no
  // device of it can take a seat, so the outcomes have nothing left to decide.
  'distribution_departures.userId': { action: 'delete' },
  'channel_members.userId': {
    action: 'code',
    by: 'ChannelService.removeAccountFromWorkspaces (governance repair before each removal)',
  },

  // -- Rows that belong to other people too, or are accounting records: anonymised -------------
  'purchase_records.userId': { action: 'anonymise' },
  'webhook_deliveries.userId': { action: 'anonymise' },
  // A boutique checkout attempt (migration 101) is the record of a request issued for money: it
  // stays, per row, like a partnership code - `product_checkouts_one_open` is a partial UNIQUE
  // (productId, userId), so two erased buyers' open attempts would collide on a constant.
  'product_checkouts.userId': { action: 'anonymise' },
  'submissions.userId': { action: 'anonymise' },
  'submissions.email': { action: 'anonymise', via: 'userId' },
  'submissions.answers': { action: 'anonymise', via: 'userId' },
  'submissions.paymentSettledBy': { action: 'anonymise' },
  'forms.ownerId': { action: 'anonymise' },
  // A consumed code must stay consumed: NULL would hand it to the next student. The replacement is
  // unique PER ROW because `(cardId, claimedByUserId)` is a partial unique index.
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
  // Who recorded how a payment paid and not granted was settled (migration 113): an accounting
  // record, kept, its author anonymised like every other authorship column.
  'purchase_record_closings.closedByUserId': { action: 'anonymise' },
  'user_moderation.mutedBy': { action: 'anonymise' },
  'document_reviewer_grants.grantedBy': { action: 'anonymise' },
  'minesweeper_bans.bannedBy': { action: 'anonymise' },
  'channels.allowedUsers': { action: 'anonymise' },

  // -- Containers that carry ids inside them ----------------------------------------------------
  'posts.comments': {
    action: 'code',
    by: 'scrubComments, over the posts CANDIDATE_POSTS_SQL locks',
  },
  'posts.polls': { action: 'code', by: 'scrubPolls, over the posts CANDIDATE_POSTS_SQL locks' },
  'posts.reactions': { action: 'anonymise', via: 'reactions' },
  // A vote on somebody else's salon poll: `metadata.poll.votesByUser[userId]`, server-readable.
  'channel_messages.metadata': { action: 'anonymise', via: 'votesByUser' },
  // The id of a mention is the account's identifier whoever wrote the post: it is removed from the
  // column and the `@[id]` token is rewritten to `@[deleted]` in the markdown and in comments.
  'posts.mentions': { action: 'anonymise' },
  'posts.markdown': { action: 'anonymise' },
  'posts.links': NO_ACCOUNT('link previews (URL, title, image) of a post'),
  'posts.images': NO_ACCOUNT('media references of a post: media ids and dimensions'),
  'posts.forms': NO_ACCOUNT('form references a post embeds'),
  'channel_messages.attachments': NO_ACCOUNT('encrypted attachment references of a salon message'),
  'channel_members.readMarks': NO_ACCOUNT('channel id -> read time of one member'),
  'channel_members.clearedMarks': NO_ACCOUNT('channel id -> clear time of one member'),
  'channel_roles.permissions': NO_ACCOUNT('the permission names of a role'),
  'channel_members.roleIds': NO_ACCOUNT('role ids of one member'),
  'forms.items': NO_ACCOUNT('the questions of a form'),

  'association_products.priceMatrix': NO_ACCOUNT('prices by tag of a product'),
  'association_products.requiredTags': NO_ACCOUNT('tag names a buyer must hold'),
  'forms.priceMatrix': NO_ACCOUNT('prices by tag of a form'),
  'forms.paymentMethods': NO_ACCOUNT('payment methods a form accepts'),
  'forms.submitCondition': NO_ACCOUNT('the audience condition (tags, promos) of a form'),
  'channel_members.notifLevels': NO_ACCOUNT('channel id -> notification level of one member'),
  'poster_projects.layout': NO_ACCOUNT('the layout of a poster'),
  'poster_projects.publication': NO_ACCOUNT(
    'the normalized map geometry published for portail-etu'
  ),
  'user_tags.metadata': {
    action: 'delete',
    via: 'userId',
  },
  'legacy_cotisations.metadata': {
    action: 'delete',
    via: 'claimedByUserId',
  },

  // -- Bookings ({@link BOOKINGS_ERASURE_STATEMENTS}, docs/wiki/bookings-chantier.md) ------------
  // A PERSONAL space goes with everything under it (D27); an association's keeps living and only
  // its creator id is anonymised. The history stays frozen (D15) under the tombstone.
  'booking_spaces.ownerId': { action: 'anonymise' },
  'booking_spaces.audience': NO_ACCOUNT('the audience condition (tags, promos) of a space'),
  'booking_spaces.items': NO_ACCOUNT('the questions of a space'),
  // The link grants a view of the resource's bookings; it is not history, so it is cut (NULL).
  'booking_resources.linkedUserId': { action: 'anonymise' },
  'booking_blocks.createdById': { action: 'anonymise' },
  'bookings.holderId': { action: 'anonymise' },
  'bookings.bookedById': { action: 'anonymise' },
  'bookings.cancelledById': { action: 'anonymise' },
  // Its answers are its own data and nothing needs them once it is gone: purged now (D18 early).
  'bookings.answers': { action: 'anonymise', via: 'holderId' },
  'bookings.holderName': {
    action: 'kept',
    reason:
      'D15: a deleted account leaves the name it had in a frozen booking; the one-year maximum age (D19) bounds it',
  },
  'booking_participants.userId': { action: 'anonymise' },
  'booking_participants.userName': {
    action: 'kept',
    reason:
      'D15: a deleted account leaves the name it had in a frozen booking; the one-year maximum age (D19) bounds it',
  },
  // A file answer (D7, WP-B6) is its uploader's, as a form's: the row goes, the media service's
  // part deletes the blob (class `form-file`), and the answer reads "file deleted".
  'booking_files.uploaderId': { action: 'delete' },
  'booking_files.fileName': { action: 'delete', via: 'uploaderId' },
  'booking_spaces.poster': NO_ACCOUNT("the encrypted media reference of a space's poster"),

  // -- Lives ({@link LIVES_ERASURE_STATEMENTS}, docs/wiki/services/lives.md) ---------------------
  // A live is its broadcaster's content and has no replay (L3): the erasure ENDS it and anonymises
  // it in one statement, and the live sweep then deletes its segments and its row.
  'lives.broadcasterId': { action: 'anonymise' },
  'live_removed_viewers.viewerId': { action: 'delete' },
  'live_starts.broadcasterId': { action: 'delete' },
  // A cut is a moderation record ABOUT the broadcaster (WP-L8): it goes with their account. The
  // moderator who cut is anonymised - the decision stays, the name goes.
  'live_cuts.broadcasterId': { action: 'delete' },
  'live_cuts.reviewerId': { action: 'anonymise' },
  'live_rules_acceptances.userId': { action: 'delete' },
  // The live chat (WP-L6): the account's messages and reaction taps go; a count map holds no id.
  'live_chat_messages.authorId': { action: 'delete' },
  'live_reaction_bursts.userId': { action: 'delete' },
  // The strike ladder (WP-L8b): a withdrawal is a record ABOUT the account, and goes with it; the
  // moderator who decided is anonymised, as a cut's.
  'live_broadcast_withdrawals.userId': { action: 'delete' },
  'live_broadcast_withdrawals.reviewerId': { action: 'anonymise' },
  // A REPORTED chat line stays until its report is handled or the 90-day bound, even once its
  // author erased their account (owner, 2026-10-20): the author's id goes, the words stay for staff.
  'live_chat_reported_lines.authorId': { action: 'anonymise' },
  'live_chat_reported_lines.authorSignature': NO_ACCOUNT(
    'an HMAC over the report id and the author id, never an id itself; it reads erased once anonymised'
  ),
  'live_chat_reported_lines.reporterSignature': NO_ACCOUNT(
    'an HMAC over the report id and the reporter id, never an id itself; it reads erased once anonymised'
  ),
  'live_reaction_bursts.counts': NO_ACCOUNT(
    'a reaction kind to tap count map (like, fire, ...), never an id'
  ),

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
 * The bookings part of the erasure (docs/wiki/bookings-chantier.md, "A deleted account"), in order:
 * what reads the account as HOLDER (cancel, withdraw, purge) runs before its ids are tombstoned,
 * and the rows are taken in the booking path's own lock order - SPACES, then RESOURCES, then
 * bookings - so an erasure racing a booking on a resource the account is linked to waits or is
 * waited for, and never deadlocks (a booking holds the space and resource locks while it inserts,
 * and the insert waits on the booking row this erasure cancels).
 *
 * - A PERSONAL space it owns is deleted, and the foreign keys cascade everything under it (D27) -
 *   other people's coming bookings there included: nobody else can manage that space.
 * - A COMING live booking it holds is cancelled by the tombstone, which frees the slot; a coming
 *   participation is withdrawn. A deleted account will not come.
 * - The answers of every booking it held are purged now rather than N days after the slot (D18).
 * - The frozen history (D15) keeps its rows: every id becomes {@link DELETED_ACCOUNT} - which
 *   migration 087's partial unique index on `booking_participants` names - and the name snapshots
 *   stay, bounded by the one-year maximum age (D19). A linked resource is unlinked.
 *
 * Exported apart so `bookings.integration.spec.ts` runs exactly these against the schema 087 builds.
 */
export const BOOKINGS_ERASURE_STATEMENTS: readonly ErasureStatement[] = [
  {
    label: 'bookings_personal_spaces',
    sql: `DELETE FROM booking_spaces WHERE "associationId" IS NULL AND "ownerId" = $1`,
  },
  {
    label: 'bookings_space_owner',
    sql: `UPDATE booking_spaces SET "ownerId" = $2 WHERE "ownerId" = $1`,
  },
  {
    label: 'bookings_linked_resource',
    sql: `UPDATE booking_resources SET "linkedUserId" = NULL WHERE "linkedUserId" = $1`,
  },
  {
    label: 'bookings_coming_cancelled',
    sql: `UPDATE bookings SET "cancelledAt" = now(), "cancelledById" = $2
           WHERE "holderId" = $1 AND "cancelledAt" IS NULL AND "startsAt" > now()`,
  },
  {
    label: 'bookings_coming_withdrawn',
    sql: `UPDATE booking_participants p SET "withdrawnAt" = now()
            FROM bookings b
           WHERE b.id = p."bookingId" AND p."userId" = $1 AND p."withdrawnAt" IS NULL
             AND b."cancelledAt" IS NULL AND b."startsAt" > now()`,
  },
  {
    label: 'bookings_answers',
    sql: `UPDATE bookings SET answers = NULL, "answersPurgedAt" = now()
           WHERE "holderId" = $1 AND answers IS NOT NULL`,
  },
  { label: 'bookings_holder', sql: `UPDATE bookings SET "holderId" = $2 WHERE "holderId" = $1` },
  {
    label: 'bookings_booked_by',
    sql: `UPDATE bookings SET "bookedById" = $2 WHERE "bookedById" = $1`,
  },
  {
    label: 'bookings_cancelled_by',
    sql: `UPDATE bookings SET "cancelledById" = $2 WHERE "cancelledById" = $1`,
  },
  {
    label: 'bookings_participants',
    sql: `UPDATE booking_participants SET "userId" = $2 WHERE "userId" = $1`,
  },
  {
    label: 'bookings_blocks',
    sql: `UPDATE booking_blocks SET "createdById" = $2 WHERE "createdById" = $1`,
  },
  // Last, after the bookings: the booking path writes these rows after its booking (lock order).
  // The media service's part of the erasure deletes the blobs (class `form-file`, owned by the
  // uploader); the answer keeps the id, which now reads "file deleted" (`splitAnswerFiles`).
  {
    label: 'bookings_files',
    sql: `DELETE FROM booking_files WHERE "uploaderId" = $1`,
  },
];

/**
 * The lives part of the erasure (docs/wiki/services/lives.md, "A deleted account").
 *
 * - A live the account broadcast is ENDED (reason `erased`, unless it had already ended) and its
 *   broadcaster becomes {@link DELETED_ACCOUNT}, in ONE statement: an open live never carries the
 *   tombstone, and the partial unique index (one OPEN live per broadcaster) never sees two. The live
 *   sweep deletes the segments and then the row within one run; nothing of it is served meanwhile,
 *   because every read of an ended live is a 410.
 * - The account's place on another live's removed-viewer list is deleted.
 * - Its `live_starts` rows (the rolling hour `LIVE_STARTS_PER_HOUR` counts) are deleted.
 * - The cuts of its lives (`live_cuts`, WP-L8) and its first-live rules acceptance are deleted; a
 *   cut it made AS A MODERATOR keeps the decision and loses the name.
 *
 * LOCK ORDER: `lives` first, then `live_cuts` - the order a staff cut takes them (the live's row
 * lock, then the cut's insert) - so an erasure racing a cut waits or is waited for, never deadlocks.
 * - Its live chat messages and reaction bursts, on any live, are deleted (WP-L6, migration 098).
 * - A withdrawal of its right to broadcast is deleted; one it decided as a moderator is anonymised.
 * - A REPORTED line it wrote (`live_chat_reported_lines`) is KEPT, its author anonymised: the line
 *   stays until its report is handled or the 90-day bound (owner, 2026-10-20). AFTER the messages'
 *   delete: a chat-line report holds the message `FOR SHARE` until it commits, so this statement,
 *   running after that delete waited, sees the kept line the report wrote.
 *
 * Exported apart so `lives.integration.spec.ts` runs exactly these against the schema 091 builds.
 */
export const LIVES_ERASURE_STATEMENTS: readonly ErasureStatement[] = [
  {
    label: 'lives_broadcaster',
    sql: `UPDATE lives
             SET "broadcasterId" = $2,
                 "endReason" = COALESCE("endReason", 'erased'),
                 "endedAt" = COALESCE("endedAt", now())
           WHERE "broadcasterId" = $1`,
  },
  {
    label: 'live_removed_viewers',
    sql: `DELETE FROM live_removed_viewers WHERE "viewerId" = $1`,
  },
  {
    label: 'live_starts',
    sql: `DELETE FROM live_starts WHERE "broadcasterId" = $1`,
  },
  {
    label: 'live_cuts',
    sql: `DELETE FROM live_cuts WHERE "broadcasterId" = $1`,
  },
  {
    label: 'live_cuts_reviewer',
    sql: `UPDATE live_cuts SET "reviewerId" = $2 WHERE "reviewerId" = $1`,
  },
  {
    label: 'live_rules_acceptances',
    sql: `DELETE FROM live_rules_acceptances WHERE "userId" = $1`,
  },
  // AFTER lives_broadcaster: a chat write takes the live's row lock, then writes its row, so the
  // erasure takes them in the same order and the two wait for each other rather than deadlock.
  {
    label: 'live_chat_messages',
    sql: `DELETE FROM live_chat_messages WHERE "authorId" = $1`,
  },
  {
    label: 'live_reaction_bursts',
    sql: `DELETE FROM live_reaction_bursts WHERE "userId" = $1`,
  },
  {
    label: 'live_chat_reported_lines_author',
    sql: `UPDATE live_chat_reported_lines SET "authorId" = $2 WHERE "authorId" = $1`,
  },
  {
    label: 'live_broadcast_withdrawals',
    sql: `DELETE FROM live_broadcast_withdrawals WHERE "userId" = $1`,
  },
  {
    label: 'live_broadcast_withdrawals_reviewer',
    sql: `UPDATE live_broadcast_withdrawals SET "reviewerId" = $2 WHERE "reviewerId" = $1`,
  },
];

/**
 * The statements that run BEFORE the scrub of other people's posts, in the order they must run inside
 * ONE transaction. Order matters where a row references another (`minesweeper_scores` before
 * `minesweeper_challenges`), and where one statement reads what the next rewrites (an association's
 * posts are anonymised before the account's own posts are deleted, so the DELETE no longer sees
 * them). NONE OF THEM WRITES A PROPOSAL: those are {@link ERASURE_PROPOSAL_STATEMENTS}, after every
 * post lock (see `lockPostRow`).
 */
export const ERASURE_ROW_STATEMENTS: readonly ErasureStatement[] = [
  // Posts published as an association stay: the association's communication, not the member's.
  {
    label: 'posts_association_author',
    sql: `UPDATE posts SET "authorId" = $2 WHERE "authorId" = $1 AND "associationId" IS NOT NULL`,
  },
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
  // Anonymised, and BEFORE the tags: closing a payment as granted locks its purchase record and
  // then writes a tag (`ProductsService.closePaidNotGranted`). Taking the record rows first, in the
  // same order, makes the two queue instead of deadlocking: an erasure that runs first is seen by
  // the closing (it refuses `granted` for an erased buyer); a closing that runs first commits its
  // tag, which the DELETE below then removes.
  {
    label: 'purchase_records',
    sql: `UPDATE purchase_records SET "userId" = $2 WHERE "userId" = $1`,
  },
  { label: 'user_tags', sql: `DELETE FROM user_tags WHERE "userId" = $1` },
  { label: 'user_moderation', sql: `DELETE FROM user_moderation WHERE "userId" = $1` },
  { label: 'form_respondents', sql: `DELETE FROM form_respondents WHERE "userId" = $1` },
  { label: 'form_reminders', sql: `DELETE FROM form_reminders WHERE "userId" = $1` },
  // Before the submissions are anonymised: a file row is found by its uploader.
  { label: 'form_files', sql: `DELETE FROM form_files WHERE "uploaderId" = $1` },
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
  {
    label: 'distribution_departures',
    sql: `DELETE FROM distribution_departures WHERE "userId" = $1`,
  },
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
  // Its salon messages, reactions and pins included. The pinned ones are read back
  // ({@link ERASED_PINS_SQL}) BEFORE this runs, so the salons can be told their pin is gone.
  { label: 'channel_messages', sql: `DELETE FROM channel_messages WHERE "authorId" = $1` },
  {
    label: 'channel_message_client_tombstones',
    sql: `DELETE FROM channel_message_client_tombstones WHERE "authorId" = $1`,
  },
  // Its vote on somebody else's salon poll.
  {
    label: 'channel_poll_votes',
    sql: `UPDATE channel_messages
             SET metadata = jsonb_set(metadata, '{poll,votesByUser}',
                                      (metadata #> '{poll,votesByUser}') - $1)
           WHERE jsonb_typeof(metadata #> '{poll,votesByUser}') = 'object'
             AND (metadata #> '{poll,votesByUser}') ? $1`,
  },
  // Its bookings: a personal space deleted, the coming ones cancelled, the history tombstoned.
  ...BOOKINGS_ERASURE_STATEMENTS,
  // Its lives: ended and anonymised, for the live sweep to delete; its removals by others, deleted.
  ...LIVES_ERASURE_STATEMENTS,

  // Anonymised (purchase_records above, before the tags)
  {
    label: 'webhook_deliveries',
    sql: `UPDATE webhook_deliveries SET "userId" = $2 WHERE "userId" = $1`,
  },
  // Unique per row, for the partial unique index named above.
  {
    label: 'product_checkouts',
    sql: `UPDATE product_checkouts SET "userId" = '[deleted]:' || id::text WHERE "userId" = $1`,
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
  { label: 'forms', sql: `UPDATE forms SET "ownerId" = $2 WHERE "ownerId" = $1` },
  // Unique per row: `idx_partnership_codes_card_claimant` is UNIQUE (cardId, claimedByUserId) WHERE
  // claimedByUserId IS NOT NULL, so two erased accounts on one card would collide on a constant -
  // and the transaction, the job and the person's sign-in with it, would fail for ever.
  {
    label: 'partnership_codes',
    sql: `UPDATE partnership_codes SET "claimedByUserId" = '[deleted]:' || id::text WHERE "claimedByUserId" = $1`,
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
  { label: 'tags_granted', sql: `UPDATE user_tags SET "grantedBy" = $2 WHERE "grantedBy" = $1` },
  {
    label: 'purchase_closings',
    sql: `UPDATE purchase_record_closings SET "closedByUserId" = $2 WHERE "closedByUserId" = $1`,
  },
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
  // `simple-array`: comma-joined text, ids stored lower-cased (`ChannelService.stripFromChannels`).
  // NOT a departure, deliberately: the salons of every community the account was still in were left
  // through `ChannelService.removeFromWorkspace` (step 1 of the erasure route), which cut their key
  // groups and stripped these lists in its own departure. What remains here is a grant in a salon of
  // a community the account had already left - a name no key group can act on, because a salon's
  // group entitles only members of its community (`isDistributionGroupEntitled`) and that earlier
  // departure already cut its seats. So there is no key distribution to cut, only the name to drop.
  // It is an access write all the same, so it raises `accessRevision` like every other one: a
  // settings panel still showing the name must not rewrite the list as if it had not changed.
  {
    label: 'channel_allowed_users',
    sql: `UPDATE channels
             SET "allowedUsers" = array_to_string(
                   array_remove(string_to_array("allowedUsers", ','), lower($1)), ','),
                 "accessRevision" = "accessRevision" + 1
           WHERE lower($1) = ANY(string_to_array("allowedUsers", ','))`,
  },
  // Its mention on OTHER people's posts: the column (comma-joined, ids compared lower-cased) ...
  {
    label: 'post_mentions',
    sql: `UPDATE posts
             SET mentions = COALESCE((SELECT string_agg(m, ',' ORDER BY n)
                                        FROM unnest(string_to_array(mentions, ',')) WITH ORDINALITY AS t(m, n)
                                       WHERE lower(m) <> lower($1)), '')
           WHERE lower($1) = ANY(string_to_array(lower(mentions), ','))`,
  },
  // ... and the `@[id]` token the text carries, which a reader renders as the person's name.
  {
    label: 'post_mention_tokens',
    // The id is regex-escaped (every non-alphanumeric character), the match is case-insensitive.
    sql: String.raw`UPDATE posts
             SET markdown = regexp_replace(markdown,
                   '@\[' || regexp_replace($1, '([^0-9a-zA-Z])', '\\\1', 'g') || '\]',
                   '@[deleted]', 'gi')
           WHERE position(lower('@[' || $1 || ']') in lower(markdown)) > 0`,
  },
  // A reaction is one key of a map: removed in place, no row needs reading.
  {
    label: 'reactions',
    sql: `UPDATE posts SET reactions = reactions - $1 WHERE reactions ? $1`,
  },
];

/**
 * The statements that write PROPOSALS (and the republications they produced), run LAST - after the
 * scrub of other people's posts. Every other writer of a proposal locks the post first and the
 * proposal second (an acceptance: `ProposalsService.lockInOrder`; a hide; a post delete through its
 * trigger); an erasure that took a proposal first and then a post the account reacted to deadlocked
 * against an acceptance holding that post (`40P01`, the erasure aborted).
 *
 * A pending person-addressed request the account ASKED (D38b) is voided, not anonymised: its asker
 * no longer speaks for the association, so it could only ever end in `PROPOSAL_SENDER_GONE`. The
 * row turns `withdrawn` with `decidedBy` = `'[voided]'` - `PROPOSAL_VOIDED_BY`, a literal here
 * because a statement binds only `$1` and `$2` (asserted by the spec). Its bell row needs no
 * statement here: the announce writes it with `actorId` = the asker (`announce`), so the head's
 * `post_notifications` statement (`"actorId" = $1`) has already deleted it.
 */
export const ERASURE_PROPOSAL_STATEMENTS: readonly ErasureStatement[] = [
  {
    label: 'proposals_voided',
    sql: `UPDATE proposals SET status = 'withdrawn', "decidedBy" = '[voided]', "decidedAt" = now()
           WHERE "proposedBy" = $1 AND kind = 'repost-personal' AND status = 'pending'`,
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
  // The republication requests addressed to the account (D38b). Its personal posts are deleted by
  // `posts` and migration 096's trigger takes their requests along; this names the column itself, so
  // a request whose post outlived that (none can, by the trigger) is still not left addressed to it.
  { label: 'proposals_to_user', sql: `DELETE FROM proposals WHERE "toUserId" = $1` },
];

/**
 * THE ERASURE'S FIRST STATEMENT: every association whose rows it will write, locked in id order.
 *
 * An association delete (`AssociationsService.remove`) takes its association `FOR UPDATE` FIRST,
 * then deletes what hangs off it: its events, its forms, its members, then the row's cascade (role
 * history, push mutes, proposals, republications, booking spaces and everything under them). The
 * erasure writes those same rows, and used to reach the association only at
 * `UPDATE associations SET "createdBy"`. So an erasure holding the account's member row of X, and a
 * delete of X holding X and its events, waited on each other (`40P01`, reproduced on PostgreSQL 18).
 * Taking every such association first puts the two in one order: whichever comes second waits
 * holding nothing. The set is EVERY association one of the erasure's writes reaches through a row
 * the delete removes - a missing source reopens the cycle for the rows it would have named.
 * A post's own `associationId` is not a source (no foreign key: the delete never writes a post), but
 * what hangs off a post or a form the erasure deletes IS: the republications of its personal posts
 * (`DELETE FROM posts` cascades into them) and its respondent rows of an association's forms.
 *
 * `FOR NO KEY UPDATE`: it conflicts with the delete's `FOR UPDATE` (the edge that matters), it is the
 * lock `UPDATE associations SET "createdBy"` takes later anyway (no upgrade), and it does NOT
 * conflict with a proposal decision's `KEY SHARE`, so a decision is not serialised behind an
 * erasure. Ordered by id, so two erasures sharing associations take them in one order too.
 */
export const ERASURE_ASSOCIATION_LOCK_SQL = `SELECT a.id FROM associations a
  WHERE a.id::text IN (
    SELECT id::text FROM associations WHERE "createdBy" = $1
    UNION SELECT "associationId"::text FROM association_members WHERE "userId" = $1
    UNION SELECT association_id::text FROM association_role_history WHERE user_id = $1
    UNION SELECT "associationId"::text FROM association_push_mutes WHERE "userId" = $1
    UNION SELECT "associationId"::text FROM association_calendar_events
           WHERE "createdBy" = $1 OR "validatedBy" = $1 OR "rejectedBy" = $1
    UNION SELECT "associationId"::text FROM forms WHERE "ownerId" = $1
    UNION SELECT f."associationId"::text FROM form_respondents fr
            JOIN forms f ON f.id = fr."formId" WHERE fr."userId" = $1
    UNION SELECT "fromAssociationId"::text FROM proposals
           WHERE "proposedBy" = $1 OR "decidedBy" = $1 OR "toUserId" = $1
    UNION SELECT "toAssociationId"::text FROM proposals WHERE "proposedBy" = $1 OR "decidedBy" = $1
    UNION SELECT "associationId"::text FROM post_republications WHERE "republishedBy" = $1
    UNION SELECT pr."associationId"::text FROM post_republications pr
            JOIN posts p ON p.id = pr."postId" WHERE p."authorId" = $1
    UNION SELECT "associationId"::text FROM booking_spaces WHERE "ownerId" = $1
    UNION SELECT s."associationId"::text FROM booking_resources r
            JOIN booking_spaces s ON s.id = r."spaceId" WHERE r."linkedUserId" = $1
    UNION SELECT s."associationId"::text FROM bookings b
            JOIN booking_resources r ON r.id = b."resourceId" JOIN booking_spaces s ON s.id = r."spaceId"
           WHERE b."holderId" = $1 OR b."bookedById" = $1 OR b."cancelledById" = $1
    UNION SELECT s."associationId"::text FROM booking_participants p
            JOIN bookings b ON b.id = p."bookingId" JOIN booking_resources r ON r.id = b."resourceId"
            JOIN booking_spaces s ON s.id = r."spaceId" WHERE p."userId" = $1
    UNION SELECT s."associationId"::text FROM booking_blocks k
            JOIN booking_resources r ON r.id = k."resourceId" JOIN booking_spaces s ON s.id = r."spaceId"
           WHERE k."createdById" = $1
    UNION SELECT s."associationId"::text FROM booking_files f
            JOIN booking_spaces s ON s.id = f."spaceId" WHERE f."uploaderId" = $1
  )
  ORDER BY a.id
  FOR NO KEY UPDATE OF a`;

/** Every statement, in the order {@link eraseSocialRows} runs them around the scrub. */
export const ERASURE_STATEMENTS: readonly ErasureStatement[] = [
  ...ERASURE_ROW_STATEMENTS,
  ...ERASURE_PROPOSAL_STATEMENTS,
];

/**
 * The parameters of one statement. Exactly the ones it uses: PostgreSQL refuses a bind that supplies
 * more parameters than the statement names ("bind message supplies 2 parameters, but prepared
 * statement requires 1"), so a `DELETE` that only names `$1` must not be handed `$2`.
 */
export function erasureParams(statement: ErasureStatement, userId: string): string[] {
  return statement.sql.includes('$2') ? [userId, DELETED_ACCOUNT] : [userId];
}

/**
 * The account's PINNED salon messages, read before they are deleted: every member's client keeps the
 * pin set it loaded, so each salon is told its pin is gone (`channel.pin`, pinned false) - otherwise
 * a phantom pin stays in the banner until the salon is reopened.
 */
export const ERASED_PINS_SQL = `SELECT id, "channelId" FROM channel_messages WHERE "authorId" = $1 AND pinned = true`;

/**
 * The media of the account's posts that STAY - the ones published as an association. media-service's
 * part of the erasure deletes every object the account uploaded except the `association` class, so
 * they are re-classed `association` first ({@link keptPostMediaIds}), and core-service runs the
 * media part only once the social part has completed (`ERASURE_TARGETS`' `after`).
 */
export const KEPT_POST_MEDIA_SQL = `SELECT m->>'mediaId' AS "mediaId"
    FROM posts p, jsonb_array_elements(p.images) m
   WHERE p."authorId" = $1 AND p."associationId" IS NOT NULL
     AND jsonb_typeof(p.images) = 'array'`;

// -- What the account left on OTHER people's posts, inside the JSONB columns ----------------------

/**
 * The posts whose comments or polls may hold the account, read and LOCKED for the scrub. `$1` is
 * {@link jsonStringLikePattern} - a candidate filter only; the scrub functions decide.
 */
export const CANDIDATE_POSTS_SQL = `SELECT id, comments, polls FROM posts
  WHERE comments::text LIKE $1 OR polls::text LIKE $1 OR comments::text ILIKE $2
  FOR UPDATE`;

/**
 * Writes one scrubbed post back: `$1` id, `$2` comments JSON, `$3` polls JSON - either NULL when that
 * column did not change, so an unchanged column is never rewritten from a copy. A JSON `null` is
 * refused the same way: the readers expand these columns as arrays (`jsonb_array_elements`), and a
 * `null` written there would break every one of them.
 */
export const WRITE_SCRUBBED_POST_SQL = `UPDATE posts
    SET comments = COALESCE(NULLIF($2::jsonb, 'null'::jsonb), comments),
        polls = COALESCE(NULLIF($3::jsonb, 'null'::jsonb), polls)
  WHERE id = $1`;

/** A stored comment. The column is `jsonb`, so the shape is open. */
type StoredComment = Record<string, any> & {
  id: string;
  userId?: string;
  parentId?: string | null;
};

/** The `@[id]` mention token of the account, matched case-insensitively with the id escaped. */
export function mentionTokenRe(userId: string): RegExp {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`@\\[${escaped}\\]`, 'gi');
}

/** The ILIKE pattern finding comments that carry the account's mention token (a candidate filter). */
export function mentionLikePattern(userId: string): string {
  return `%@[${userId.replace(/[\\%_]/g, (c) => `\\${c}`)}]%`;
}

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
  // A comment written AS an association belongs to it, not to its writer (the rule posts follow):
  // it stays, and only the account is let go of.
  const asAssociation = (c: StoredComment) => !!c.associationId;
  const removed = new Set(
    all.filter((c) => c.userId === userId && !asAssociation(c)).map((c) => c.id)
  );
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
      if (c.userId === userId && asAssociation(c)) {
        next = { ...next, userId: '' };
        changed = true;
      }
      if (c.parentId && removed.has(c.parentId)) {
        next = { ...next, parentId: survivingParent(c.parentId) };
        changed = true;
      }
      // A mention of the account inside somebody else's comment text.
      if (typeof c.text === 'string') {
        const text = c.text.replace(mentionTokenRe(userId), '@[deleted]');
        if (text !== c.text) {
          next = { ...next, text };
          changed = true;
        }
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
 * The parameters that write one candidate post back, or null when the account left nothing on it.
 * A column that did not change is passed as NULL, which {@link WRITE_SCRUBBED_POST_SQL} keeps.
 */
export function scrubbedPostParams(
  post: { id: string; comments: unknown; polls: unknown },
  userId: string
): [string, string | null, string | null] | null {
  const c = scrubComments(post.comments, userId);
  const p = scrubPolls(post.polls, userId);
  if (!c.changed && !p.changed) return null;
  return [
    post.id,
    c.changed ? JSON.stringify(c.comments) : null,
    p.changed ? JSON.stringify(p.polls) : null,
  ];
}

/**
 * The LIKE pattern that finds every post whose comments or polls mention the account as a JSON
 * string - a candidate filter only, the scrub functions decide. LIKE metacharacters in the id are
 * escaped so an id can never widen the match.
 */
export function jsonStringLikePattern(userId: string): string {
  return `%"${userId.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
}

/** The two things the erasure asks of its database: a write's row count, and a read's rows. */
export interface ErasureDb {
  write(sql: string, params: unknown[]): Promise<number>;
  read<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/** What one run of {@link eraseSocialRows} did, for the log line and the follow-ups after commit. */
export interface SocialErasureResult {
  counts: Record<string, number>;
  postsScrubbed: number;
  /** Pinned salon messages that were deleted: each salon is told its pin is gone. */
  pinsRemoved: Array<{ id: string; channelId: string }>;
}

/**
 * The media of the account's association posts, which stay with the association. Read BEFORE the
 * transaction and re-classed before it runs: the transaction anonymises those posts' author, so a
 * retry after it committed could no longer find them by the account - while a re-class that failed
 * BEFORE it simply fails the attempt, and the retry reads them again.
 */
export async function keptPostMediaIds(db: ErasureDb, userId: string): Promise<string[]> {
  return (await db.read<{ mediaId: string | null }>(KEPT_POST_MEDIA_SQL, [userId]))
    .map((r) => r.mediaId)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Runs `statements` in order on `db` (the caller's transaction) and returns the rows each one
 * changed, by label, leaving out the ones that changed nothing - the log line's `rows=`.
 */
export async function runErasureStatements(
  db: ErasureDb,
  statements: readonly ErasureStatement[],
  userId: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const statement of statements) {
    const affected = await db.write(statement.sql, erasureParams(statement, userId));
    if (affected > 0) counts[statement.label] = affected;
  }
  return counts;
}

/**
 * Every row-level part of the social erasure, to be run inside ONE transaction by the caller: the
 * statements, then the scrub of other people's posts. Idempotent. The ONE implementation, run by
 * the internal route and by the integration spec against a real database.
 */
export async function eraseSocialRows(db: ErasureDb, userId: string): Promise<SocialErasureResult> {
  // Before anything else: the associations, in the order an association delete takes them.
  const locked = await db.read<{ id: string }>(ERASURE_ASSOCIATION_LOCK_SQL, [userId]);
  const pinsRemoved = await db.read<{ id: string; channelId: string }>(ERASED_PINS_SQL, [userId]);

  const counts = await runErasureStatements(db, ERASURE_ROW_STATEMENTS, userId);
  // In the log line's `rows=`: how many associations the erasure held while it ran.
  if (locked.length > 0) counts.associations_locked = locked.length;

  // Comments, likes and poll votes need the structure, so the candidates are read and locked.
  let postsScrubbed = 0;
  const candidates = await db.read<{ id: string; comments: unknown; polls: unknown }>(
    CANDIDATE_POSTS_SQL,
    [jsonStringLikePattern(userId), mentionLikePattern(userId)]
  );
  for (const post of candidates) {
    const params = scrubbedPostParams(post, userId);
    if (!params) continue;
    await db.write(WRITE_SCRUBBED_POST_SQL, params);
    postsScrubbed += 1;
  }
  // Proposals LAST, after every post lock: the order every acceptance takes (`lockPostRow`).
  Object.assign(counts, await runErasureStatements(db, ERASURE_PROPOSAL_STATEMENTS, userId));
  return { counts, postsScrubbed, pinsRemoved };
}
