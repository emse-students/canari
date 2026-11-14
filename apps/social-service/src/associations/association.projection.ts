import { Association } from './entities/association.entity';
import type { LydiaCashierView } from './lydia-cashiers-list';
import type { LydiaReadinessCause } from './lydia-readiness';

/**
 * WHAT A CLIENT MAY READ OF AN ASSOCIATION, AS AN ALLOWLIST (2026-10-15).
 *
 * The member reads (`GET /api/associations`, `slug/:slug`, `:id`, `me/list`) and the writes that
 * answer the row (`POST`, `PATCH :id`, the two logo routes) used to spread the entity, first raw and
 * then through a DENYLIST that nulled `documentVaultKey` and `notesCiphertext`. That left
 * `lydiaAccountId` - the Lydia Business `vendor_token`, which with a sequential `request_id` is all
 * Lydia's `request/cancel` asks for - readable by every signed-in member, so anyone could cancel the
 * open payment requests of everyone paying that association. `me/list` never went through the
 * denylist at all and answered the vault master key to every member.
 *
 * A denylist has to name every secret column added later; an allowlist makes a new column private
 * until someone adds it here. The payout account (`lydiaAccountId`, `lydiaDashboardUrl`) has its own
 * read, `GET :id/payout-account`, for the holders of MANAGE_PAYOUT_ACCOUNT - the same permission the
 * onboarding and the disconnect already ask (`canManagePayoutAccount`). The vault key has its own
 * read too (`:id/vault-key`, MANAGE_DOCUMENTS), and the notes theirs (`:id/notes`).
 *
 * The seam is the CONTROLLER, not the service: `findById` is also used internally by writers
 * (`update`, `resolvePaymentTarget`), which need the whole row.
 */

/** The entity columns a signed-in member reads. Nothing that is a credential or a key. */
const ASSOCIATION_FIELDS = [
  'id',
  'name',
  'slug',
  'description',
  'bioMarkdown',
  'logoUrl',
  'logoMediaId',
  'lydiaOnboardingComplete',
  'paymentParentAssociationId',
  'paymentDelegationStatus',
  'isBDE',
  'documentQuotaBytes',
  'color',
  'type',
  'promo',
  'parentAssociationId',
  'displayParentAssociationId',
  'name2',
  'logoMediaId2',
  'archived',
  'contactEmail',
  'cotisationEnabled',
  'cotisationMode',
  'cotisationExpiresAt',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof Association)[];

/**
 * The fields the service DERIVES and attaches to a row: the member count and the parent's name
 * (`list`, `findById`, `findBySlug`), the caller's own membership (`listByUser`), and
 * `paymentsReady` (`withPaymentsReady`): whether its payments can be taken, through its own Lydia
 * account or an approved delegate's - the one field every client readiness check draws from.
 */
const DERIVED_FIELDS = [
  'memberCount',
  'parentName',
  'role',
  'permissions',
  'isAdmin',
  'paymentsReady',
] as const;

const VIEW_FIELDS: readonly string[] = [...ASSOCIATION_FIELDS, ...DERIVED_FIELDS];

type ViewField = (typeof ASSOCIATION_FIELDS)[number] | (typeof DERIVED_FIELDS)[number];

/** An association row as a signed-in member may read it: the allowlisted keys the row carries. */
export type AssociationView<T> = Pick<T, Extract<keyof T, ViewField>>;

/**
 * The payout account of an association, read only by MANAGE_PAYOUT_ACCOUNT holders: the Business
 * columns, its confirmed Responsable (name and the phone's last two digits ONLY), the last readiness
 * change and the enrolment-in-flight marker (migration 118) - the one read the payments screen's
 * steps are drawn from (frontend `lydiaEnrolmentSteps.ts`).
 */
export type AssociationPayoutAccount = Pick<
  Association,
  'lydiaAccountId' | 'lydiaDashboardUrl' | 'lydiaOnboardingComplete'
> & {
  responsable: { userId: string; name: string; phoneEnd: string; confirmed: boolean } | null;
  /** Every live cashier of the CURRENT Business, the Responsable included (lot 3). */
  cashiers: LydiaCashierView[];
  readiness: { cause: LydiaReadinessCause; at: string } | null;
  enrolmentInFlightSince: string | null;
  /** The Responsable step's claim (`lydiaResponsableStartedAt`), for the global admin's clear. */
  responsableInFlightSince: string | null;
  /**
   * A GLOBAL ADMIN's read only, and only on a bridge (lydia-account-bridge.ts): which Business
   * collects, the historical account's readiness, and the counts. The managers never read it - the
   * historical account is invisible to them (owner, 2026-11-13).
   */
  bridge?: {
    /** `historical`: the historical account collects; `switched`: the enrolled Business does. */
    state: 'historical' | 'switched';
    historicalReady: boolean;
    /** Whether the enrolment linked its Business yet. */
    enrolledLinked: boolean;
    switchedAt: string | null;
    switchCount: number;
    switchBackCount: number;
    reissueCount: number;
  };
};

/** Projects an association row onto what a signed-in member may read of it. */
export function toAssociationView<T extends Partial<Association>>(row: T): AssociationView<T> {
  const source = row as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const field of VIEW_FIELDS) {
    if (field in source) view[field] = source[field];
  }
  return view as AssociationView<T>;
}
