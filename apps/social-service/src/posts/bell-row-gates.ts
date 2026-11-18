import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { holdsBdeAgendaRightOverSql } from '../spaces/bde';
import { associationVisibleToViewerSql, eventVisibleToViewerSql } from '../spaces/reader-spaces';
import type { NotificationType } from '../push/notification-client-floor';

/** The shape of a uuid, which a varchar column must have before it is cast to one. */
export const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * `column` (a VARCHAR, or a text expression) as a uuid, or NULL when it does not have the shape of
 * one. Never for a column that already is a `uuid` (`associationId` is, since migration 061): `uuid
 * ~* text` has no operator and fails the whole bell with a 500 (#3019 on dev).
 */
export function asUuidSql(column: string): string {
  return `(CASE WHEN ${column} ~* '${UUID_SHAPE}' THEN ${column}::uuid END)`;
}

/**
 * WHAT ONE KIND OF BELL ROW IS RE-ASKED AGAINST WHEN IT IS READ:
 * - `'post'`: its `postId` is a post's, and the row is shown while its reader still sees that post
 *   (`POST_BOUND_NOTIFICATION_TYPES`, `bellRowShownSql`);
 * - `'birthday'`: shown while its reader may still read the member's date (`birthdayRowShownSql`);
 * - `'reader'`: about the reader's OWN account, booking, payment or live - nothing the reader can lose
 *   the right to read while the row exists (each entry below says why);
 * - a function: the row names something ELSE - an association queue, an event, a form, a booking
 *   space - and its SQL is the predicate that row is shown under NOW (`targetBoundRowShownSql`).
 */
export type BellRowGate = 'post' | 'birthday' | 'reader' | ((row: BellRowRefs) => string);

/** The SQL expressions a target gate reads from bell row `n`. */
export interface BellRowRefs {
  /** The reader, `n."recipientId"`. */
  reader: string;
  /** `n."postId"` as a uuid, NULL when it has no uuid's shape (fail closed: no row matches it). */
  target: string;
  /** `n.meta`, the row's structured facts (a jsonb). */
  meta: string;
}

/**
 * Bell reader `reader` holds `flag` in association `association` through their OWN membership row -
 * the member tier `listFlagHolders` and `holdersOf` read when they chose the recipients, so a row is
 * shown exactly while its reader would be chosen again.
 *
 * A SCALAR aggregate on the `(associationId, userId)` unique key, never an `EXISTS`: the planner may
 * turn an `EXISTS` correlated by plain equalities into a hashed subplan, which reads every flag
 * holder of the whole table once per kind met on the page - a scan whose cost grows with the
 * estate, not with the reader (measured 2026-11-14, posts.md). A scalar subquery is never hashed:
 * each row costs one probe of the unique index. `bit_or` rather than the bare column, so the
 * expression stays defined over any number of rows instead of failing the whole bell.
 */
function holdsFlagSql(
  association: string,
  reader: string,
  flag: AssociationPermissionFlag
): string {
  return `((COALESCE((SELECT bit_or(bell_role.permissions) FROM association_members bell_role
      WHERE bell_role."associationId" = ${association} AND bell_role."userId" = ${reader}), 0)
      & ${flag}) <> 0)`;
}

/** A row addressed to the holders of `flag` in the association its `postId` names. */
const roleInTarget =
  (flag: AssociationPermissionFlag) =>
  ({ reader, target }: BellRowRefs): string =>
    holdsFlagSql(target, reader, flag);

/**
 * A row told to who may VALIDATE the events of the association its `postId` names
 * (`notifyEventValidatorsOfProposal`): the BDE agenda right over it (`holdsBdeAgendaRightOverSql`,
 * the predicate the recipients were read with), or a platform administrator (told when a targeted
 * space has no BDE, and who validates any event). The administrator is read as a scalar on the
 * primary key, for the reason `holdsFlagSql` gives.
 */
function eventValidatorSql({ reader, target }: BellRowRefs): string {
  return `(${holdsBdeAgendaRightOverSql(reader, target)}
    OR COALESCE((SELECT bool_or(bell_admin.admin) FROM users bell_admin WHERE bell_admin.id = ${reader}), false))`;
}

/**
 * A row told to an event's PARTIES (`notifyEventReopenedParties`): the `PROPOSE_EVENT` holders of
 * the organiser its `postId` names, and of each ACCEPTED co-organiser of the event `meta.eventId`
 * names. A row written before `meta.eventId` names no event, so only the organiser's holders keep
 * it - fail closed, as a malformed post-bound row is.
 */
function eventPartySql(row: BellRowRefs): string {
  const event = asUuidSql(`(${row.meta}->>'eventId')`);
  return `(${holdsFlagSql(row.target, row.reader, AssociationPermissionFlag.PROPOSE_EVENT)}
    OR EXISTS (SELECT 1 FROM association_calendar_event_co_owners bell_party
      WHERE bell_party.event_id = ${event}
        AND ${holdsFlagSql('bell_party.association_id', row.reader, AssociationPermissionFlag.PROPOSE_EVENT)}))`;
}

/** The row recorded, when it was written, that it REPLACED its reader's party notice. */
function toldAsPartySql(row: BellRowRefs): string {
  return `(${row.meta}->>'toldAsParty') = 'true'`;
}

/**
 * A row written to the VALIDATORS: shown while its reader holds the validator's right - or, for a row
 * that REPLACED its reader's party notice (`meta.toldAsParty`, written by
 * `notifyEventValidatorsOfProposal` on a reopening, where the writer drops the validators from the
 * parties), while they hold a party's right (`eventPartySql`), since the party notice they were not
 * sent would still be shown. Every other validators' row - a first proposal, a row written before
 * the flag - follows the validator's right alone (fail closed).
 */
function validatorRowSql(row: BellRowRefs): string {
  return `(${eventValidatorSql(row)} OR (${toldAsPartySql(row)} AND ${eventPartySql(row)}))`;
}

/** The SQL expressions of bell row `n` the gates read (`BellRowRefs`). */
function bellRowRefs(n: string): BellRowRefs {
  return { reader: `${n}."recipientId"`, target: asUuidSql(`${n}."postId"`), meta: `${n}.meta` };
}

/**
 * Bell row `n`, a validators' row that replaced its reader's party notice, is admitted NOW by the
 * party's right alone: its reader no longer validates. Such a row is served as the party notice it
 * replaced (`PostNotificationsService.getNotifications`), so it never opens the validation queue
 * its reader can no longer open.
 */
export function validatorRowServedAsPartySql(n: string): string {
  const row = bellRowRefs(n);
  return `(${toldAsPartySql(row)} AND NOT ${eventValidatorSql(row)})`;
}

/**
 * THE BELL'S GATE FOR EVERY KIND, exhaustive over `NotificationType` so a new kind does not compile
 * until it says what its row is re-asked against (audit of 2026-11-14: the rows bound to no post were
 * re-asked against nothing, so an event's or a form's title outlived its reader's right to it for the
 * rows' whole 90-day life). docs/wiki/frontend/modules/posts.md, "The bell re-checks what a row
 * points at".
 */
export const BELL_ROW_GATE: Readonly<Record<NotificationType, BellRowGate>> = {
  comment: 'post',
  reply: 'post',
  reaction: 'post',
  mention: 'post',
  association_post: 'post',
  followed_post: 'post',
  association_repost: 'post',
  member_repost: 'post',
  repost_personal_requested: 'post',
  repost_personal_accepted: 'post',
  repost_personal_refused: 'post',
  friend_reaction: 'post',
  friend_comment: 'post',
  campus_trend: 'post',
  birthday: 'birthday',
  // A proposal to an association is told to its `POST_AS_ASSO` holders (`holdersOf`); `postId` is
  // the receiving association's queue.
  repost_proposed: roleInTarget(AssociationPermissionFlag.POST_AS_ASSO),
  coorganise_proposed: roleInTarget(AssociationPermissionFlag.POST_AS_ASSO),
  // What a calendar manager did with an event, told to the organiser's `PROPOSE_EVENT` holders.
  event_validated: roleInTarget(AssociationPermissionFlag.PROPOSE_EVENT),
  event_updated: roleInTarget(AssociationPermissionFlag.PROPOSE_EVENT),
  event_deleted: roleInTarget(AssociationPermissionFlag.PROPOSE_EVENT),
  event_rejected: roleInTarget(AssociationPermissionFlag.PROPOSE_EVENT),
  event_proposed: validatorRowSql,
  event_pending: eventPartySql,
  // Told to the validators (`meta.audience = 'validators'`) and to the parties, under one type.
  event_pending_coorganiser: (row) =>
    `(CASE WHEN ${row.meta}->>'audience' = 'validators'
      THEN ${validatorRowSql(row)} ELSE ${eventPartySql(row)} END)`,
  // An event's opening, told to its organiser's followers: shown while the event is on the agenda
  // (validated, organiser not archived - the opening's own `targetLive`) and its reader sees it.
  event_open: ({ reader, target }) => `EXISTS (SELECT 1 FROM association_calendar_events bell_ev
      JOIN associations bell_ev_asso ON bell_ev_asso.id = bell_ev."associationId"
      WHERE bell_ev.id = ${target} AND bell_ev.status = 'validated' AND NOT bell_ev_asso.archived
        AND ${eventVisibleToViewerSql('bell_ev', reader)})`,
  // A booking space's opening, told to followers of a LISTED space with no audience (L25): shown
  // while it is still that, and listed to its reader (`listedSpaces`' predicate).
  booking_open: ({ reader, target }) => `EXISTS (SELECT 1 FROM booking_spaces bell_space
      JOIN associations bell_space_asso ON bell_space_asso.id = bell_space."associationId"
      WHERE bell_space.id = ${target} AND NOT bell_space_asso.archived
        AND bell_space.discoverability = 'listed'
        AND (bell_space.audience IS NULL OR bell_space.audience = 'null'::jsonb)
        AND ${associationVisibleToViewerSql('bell_space."associationId"', reader)})`,
  // A paid answer over capacity, told to the form's owner and its `MANAGE_FORMS` holders.
  form_paid_over_capacity: ({ reader, target }) => `EXISTS (SELECT 1 FROM forms bell_form
      WHERE bell_form.id = ${target} AND (bell_form."ownerId" = ${reader}
        OR ${holdsFlagSql('bell_form."associationId"', reader, AssociationPermissionFlag.MANAGE_FORMS)}))`,
  // Told to an association's payout managers and shop managers (`listFlagHolders`).
  lydia_payments_active: roleInTarget(AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT),
  lydia_payments_paused: roleInTarget(AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT),
  delegation_revoked: roleInTarget(AssociationPermissionFlag.MANAGE_PRODUCTS),
  delegation_receiver_not_ready: roleInTarget(AssociationPermissionFlag.MANAGE_PRODUCTS),
  delegation_resumed: roleInTarget(AssociationPermissionFlag.MANAGE_PRODUCTS),
  // The reader's own: a fixed sentence about an opening they asked for or follow (no title).
  form_reminder: 'reader',
  // The reader's own bookings: what happened to THEIR place - a removal is the very thing told.
  booking_cancelled: 'reader',
  booking_withdrawn: 'reader',
  booking_added: 'reader',
  booking_reminder: 'reader',
  booking_changed: 'reader',
  booking_removed: 'reader',
  // The reader's own profile, follow, payment, cashier enrolment and live.
  profile_correction_applied: 'reader',
  profile_correction_refused: 'reader',
  follow_request: 'reader',
  follow_accepted: 'reader',
  lydia_refund_issued: 'reader',
  lydia_cashier_added: 'reader',
  live_cut: 'reader',
  live_suspended: 'reader',
  live_withdrawn: 'reader',
  live_reinstated: 'reader',
};

/** The kinds whose row names something other than a post, re-asked by `targetBoundRowShownSql`. */
export const TARGET_BOUND_NOTIFICATION_TYPES: readonly NotificationType[] = (
  Object.keys(BELL_ROW_GATE) as NotificationType[]
).filter((type) => typeof BELL_ROW_GATE[type] === 'function');

/**
 * Bell row `n` is not target-bound, or the predicate of what it names admits its reader NOW
 * (`BELL_ROW_GATE`): ONE CASE over the row's type, so each row runs its own kind's correlated
 * subquery and nothing else, inside the bell's single statement (`bellPageQuery`, the index walk that
 * stops with the page). A row that fails is not served, so not counted unread either; it is left to
 * the 90-day sweep, exactly as a post-bound row.
 */
export function targetBoundRowShownSql(n: string): string {
  const row = bellRowRefs(n);
  const arms = TARGET_BOUND_NOTIFICATION_TYPES.map((type) => {
    const gate = BELL_ROW_GATE[type] as (refs: BellRowRefs) => string;
    return `WHEN '${type}' THEN ${gate(row)}`;
  });
  return `(CASE ${n}.type ${arms.join('\n    ')} ELSE true END)`;
}
