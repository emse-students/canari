import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';

/** The two roles lot 3 adds; the Responsable is lot 2's own step. */
export type LydiaAddableCashierRole = 'tresorier' | 'vendeur';

/** Every role a `lydia_cashiers` row may hold (migration 118's CHECK). */
export type LydiaCashierRole = 'responsable' | LydiaAddableCashierRole;

/** Which number of a cashier row a removal is about: its own, or a Responsable's old one. */
export type LydiaCashierNumber = 'current' | 'previous';

/** One live cashier of an association's CURRENT Business, as the payments screen lists it. */
export interface LydiaCashierView {
  id: string;
  userId: string;
  name: string;
  role: LydiaCashierRole;
  /** The current number's last two digits: the ONLY phone data any read returns. */
  phoneEnd: string;
  /**
   * `confirmed`: Lydia's read showed exactly the role's rights. `unconfirmed`: Lydia answered the
   * add and did not confirm them. `revoke-unconfirmed`: a removal was asked and Lydia's re-read did
   * not show 0 rights - the row stays, Lydia may still list the person.
   */
  state: 'confirmed' | 'unconfirmed' | 'revoke-unconfirmed';
  /**
   * A Responsable's OTHER number (last two digits): the old one after a confirmed number change,
   * or a new one Lydia did not confirm. Lydia may still list it, so it is shown for removal.
   */
  previousPhoneEnd: string | null;
  /** ISO instant of the add (or of the last re-add). */
  addedAt: string;
  addedByName: string;
  /**
   * The person holds no membership of the association any more (they left or were removed): the
   * row's numbers are owed a removal at Lydia ({@link owesDepartureRemoval}). A Responsable keeps
   * their current number - the Business needs one - and the managers are told a new one is needed.
   */
  departed: boolean;
}

/**
 * Whether row `cashier` owes a removal at Lydia because its person is no longer a member: every
 * number of a Tresorier or Vendeur, and a Responsable's OTHER number - never the Responsable's
 * current one. The ONE predicate the payments card's retry and the departure itself read.
 */
export function owesDepartureRemoval(
  cashier: Pick<LydiaCashierView, 'departed' | 'role' | 'previousPhoneEnd'>
): boolean {
  return cashier.departed && (cashier.role !== 'responsable' || cashier.previousPhoneEnd !== null);
}

/**
 * The SQL predicate "this cashier row's person is no longer a member of its association", for a
 * `lydia_cashiers` alias `c`: the one definition of a departure the list and the debt read.
 */
export const CASHIER_DEPARTED_SQL = `NOT EXISTS (SELECT 1 FROM association_members m
                    WHERE m."associationId" = c."associationId" AND m."userId" = c."userId")`;

/** The query a cashier read runs on: a repository's or a transaction manager's. */
export type LydiaCashierQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/**
 * The live cashiers of association `id`'s Business `vendorToken`, Responsable first then by date
 * added: names, roles, the last two digits of each number and the row's state. Never a sealed phone.
 */
export async function listLydiaCashiers(
  query: LydiaCashierQuery,
  id: string,
  vendorToken: string
): Promise<LydiaCashierView[]> {
  const rows = (await query(
    `SELECT c.id, c."userId", c.role, c."phoneEnd", c."previousPhoneEnd", c."addedAt",
            (c."confirmedAt" IS NOT NULL) AS confirmed,
            (c."revokeUnconfirmedAt" IS NOT NULL) AS "revokeUnconfirmed",
            ${CASHIER_DEPARTED_SQL} AS departed,
            u."displayName", u."firstName", u."lastName",
            a."displayName" AS "byDisplayName", a."firstName" AS "byFirstName",
            a."lastName" AS "byLastName"
       FROM lydia_cashiers c
       LEFT JOIN users u ON u.id = c."userId"
       LEFT JOIN users a ON a.id = c."addedByUserId"
      WHERE c."associationId" = $1 AND c."vendorToken" = $2 AND c."removedAt" IS NULL
      ORDER BY (c.role = 'responsable') DESC, c."addedAt" ASC`,
    [id, vendorToken]
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.userId),
    name: formatUserDisplayNameFromRaw(row) || '',
    role: row.role as LydiaCashierRole,
    phoneEnd: String(row.phoneEnd ?? ''),
    state:
      row.revokeUnconfirmed === true
        ? 'revoke-unconfirmed'
        : row.confirmed === true
          ? 'confirmed'
          : 'unconfirmed',
    previousPhoneEnd: typeof row.previousPhoneEnd === 'string' ? row.previousPhoneEnd : null,
    addedAt: new Date(row.addedAt as string).toISOString(),
    addedByName:
      formatUserDisplayNameFromRaw({
        displayName: row.byDisplayName,
        firstName: row.byFirstName,
        lastName: row.byLastName,
      }) || '',
    departed: row.departed === true,
  }));
}
