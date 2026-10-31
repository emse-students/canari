import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import type { EntityManager, Repository } from 'typeorm';
import { Association } from './entities/association.entity';
import { AssociationsService, LYDIA_CASHIER_PHONE_PURPOSE } from './associations.service';
import { LydiaCashierNotifier } from './lydia-payments-notifier.service';
import { isSecretBoxConfigured, openSecret, sealSecret } from '../common/secret-box';
import { sanitizeLog } from '../common/log.utils';
import {
  listLydiaCashiers,
  type LydiaCashierNumber,
  type LydiaCashierQuery as Query,
  type LydiaCashierRole,
  type LydiaCashierView,
} from './lydia-cashiers-list';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import { describeHttpError } from '../common/http-error-log';

/** The `code` (409) of a cashier operation while another one on the association is in flight. */
export const LYDIA_CASHIER_IN_FLIGHT = 'LYDIA_CASHIER_IN_FLIGHT';
/** The `code` (400) of a cashier who is not a member of the association. */
export const LYDIA_CASHIER_NOT_A_MEMBER = 'LYDIA_CASHIER_NOT_A_MEMBER';
/** The `code` (409) of adding a member who already is a live cashier of the association. */
export const LYDIA_CASHIER_ALREADY_SET = 'LYDIA_CASHIER_ALREADY_SET';
/**
 * The `code` (409) of a number already held by a live cashier row of the association (its own or an
 * old Responsable number): adding it again would REPLACE that cashier's rights at Lydia.
 */
export const LYDIA_CASHIER_PHONE_IN_USE = 'LYDIA_CASHIER_PHONE_IN_USE';
/** The `code` (409) when no CONFIRMED Responsable exists: nobody Lydia lets remove a cashier. */
export const LYDIA_CASHIER_NO_HOLDER = 'LYDIA_CASHIER_NO_HOLDER';
/** The `code` (409) of removing the Responsable's current number: the only one managing cashiers. */
export const LYDIA_CASHIER_LAST_HOLDER = 'LYDIA_CASHIER_LAST_HOLDER';
/** The `code` (404) of a cashier row (or old number) that is not live on the current Business. */
export const LYDIA_CASHIER_NOT_FOUND = 'LYDIA_CASHIER_NOT_FOUND';
/** The `code` (409) of changing the Responsable's role: that is lot 2's step, never a role change. */
export const LYDIA_CASHIER_ROLE_FIXED = 'LYDIA_CASHIER_ROLE_FIXED';
/** core-service's `code` (409) of an association with no Business linked, reused for the cashier steps. */
export const LYDIA_NO_BUSINESS = 'LYDIA_NO_BUSINESS';
/** Mirrors `AssociationsService`'s code for a Business that changed between two steps. */
const LYDIA_BUSINESS_CHANGED = 'LYDIA_BUSINESS_CHANGED';

/** What a cashier phone must look like: E.164, as core-service validated it. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** How long one erasure removal may take at core-service before it is given up (best effort). */
export const ERASURE_REVOKE_TIMEOUT_MS = 30_000;

/** What a removal needs from this service: the Business, the number to remove and who acts. */
export interface LydiaCashierRevokeTarget {
  vendorToken: string;
  cashierPhone: string;
  actorPhone: string;
}

/** A live row as the checks read it, sealed phones included (never returned to a caller). */
interface LiveRow {
  id: string;
  userId: string;
  role: LydiaCashierRole;
  phoneSealed: string | null;
  previousPhoneSealed: string | null;
  confirmedAt: Date | null;
}

const LIVE_ROWS_SQL = `SELECT id, "userId", role, "phoneSealed", "previousPhoneSealed", "confirmedAt"
  FROM lydia_cashiers
 WHERE "associationId" = $1 AND "vendorToken" = $2 AND "removedAt" IS NULL`;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

/** The written row count of a raw `UPDATE ... RETURNING`, whatever shape the driver answered. */
function returnedCount(result: unknown[]): number {
  return Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;
}

/**
 * THE CASHIERS OF AN ASSOCIATION'S LYDIA BUSINESS BEYOND THE RESPONSABLE (Lydia enrolment lot 3):
 * the checks and the claim before core-service asks Lydia anything, the record of what Lydia
 * answered, and the removal before an account's erasure. Lydia itself is only ever called by
 * core-service (`payment.controller.ts`); this service owns the rows, the sealed numbers and the
 * one claim (`associations."lydiaResponsableStartedAt"`, migration 118) every cashier operation of
 * an association takes, the Responsable's step included - so two operations on the cashiers of one
 * Business never reach Lydia together. A claim is released by every record, by a typed refusal, or
 * by a global admin (`lydia-enrolment-clear`). Phones are never logged.
 */
@Injectable()
export class LydiaCashiersService {
  private readonly logger = new Logger(LydiaCashiersService.name);

  constructor(
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    private readonly associations: AssociationsService,
    private readonly notifier: LydiaCashierNotifier,
    private readonly httpService: HttpService
  ) {}

  /** Opens a sealed number of association `id`; null (said at ERROR) when the seal does not open. */
  private open(id: string, sealed: string | null, what: string): string | null {
    if (!sealed) return null;
    try {
      return openSecret(LYDIA_CASHIER_PHONE_PURPOSE, id, sealed);
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-CASHIER] ${what} of association ${sanitizeLog(id)} cannot be opened: ` +
          `${err instanceof Error ? err.name : String(err)}`
      );
      return null;
    }
  }

  /** The live rows of the Business, sealed numbers included. */
  private async liveRows(query: Query, id: string, vendorToken: string): Promise<LiveRow[]> {
    return (await query(LIVE_ROWS_SQL, [id, vendorToken])) as LiveRow[];
  }

  /** The Business linked now, or the typed 409 `LYDIA_NO_BUSINESS`. */
  private async vendorTokenOrThrow(id: string): Promise<string> {
    const vendorToken = await this.associations.lydiaVendorTokenOf(id);
    if (!vendorToken) {
      this.logger.warn(`[LYDIA-CASHIER] refused on ${sanitizeLog(id)}: no Business linked`);
      throw conflict(LYDIA_NO_BUSINESS, 'No Lydia Business is linked to this association');
    }
    return vendorToken;
  }

  /**
   * The CONFIRMED Responsable's current number, which every removal needs. The typed 409
   * `LYDIA_CASHIER_NO_HOLDER` when there is none (or it is not confirmed), a 503 when its seal does
   * not open.
   */
  private holderPhoneOrThrow(id: string, rows: LiveRow[]): { row: LiveRow; phone: string } {
    const holder = rows.find((row) => row.role === 'responsable' && row.confirmedAt != null);
    if (!holder) {
      this.logger.warn(`[LYDIA-CASHIER] refused on ${sanitizeLog(id)}: no confirmed Responsable`);
      throw conflict(LYDIA_CASHIER_NO_HOLDER, 'The Responsable must be confirmed by Lydia first');
    }
    const phone = this.open(id, holder.phoneSealed, "the Responsable's number");
    if (!phone) throw new ServiceUnavailableException("The Responsable's number cannot be read");
    return { row: holder, phone };
  }

  /**
   * THE claim of a cashier operation: ONE statement on the association row, taken only while the
   * Business is still `vendorToken` and no other operation holds it. The loser reads the typed 409
   * `LYDIA_CASHIER_IN_FLIGHT`, or `LYDIA_BUSINESS_CHANGED`.
   */
  private async claim(id: string, vendorToken: string, what: string): Promise<void> {
    const result: unknown[] = await this.assoRepo.query(
      `UPDATE associations SET "lydiaResponsableStartedAt" = now()
        WHERE id = $1 AND "lydiaAccountId" = $2 AND "lydiaResponsableStartedAt" IS NULL
        RETURNING id`,
      [id, vendorToken]
    );
    if (returnedCount(result) > 0) {
      this.logger.log(`[LYDIA-CASHIER] ${what} claimed on association ${sanitizeLog(id)}`);
      return;
    }
    if ((await this.associations.lydiaVendorTokenOf(id)) !== vendorToken) {
      this.logger.warn(`[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: Business changed`);
      throw conflict(LYDIA_BUSINESS_CHANGED, 'The Lydia Business of this association changed');
    }
    this.logger.warn(
      `[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: another cashier operation is in flight`
    );
    throw conflict(LYDIA_CASHIER_IN_FLIGHT, 'Another cashier operation is in flight');
  }

  /** Releases the claim after an outcome core-service knows; never on an unknown add. */
  async release(id: string): Promise<void> {
    await this.assoRepo.query(
      `UPDATE associations SET "lydiaResponsableStartedAt" = NULL WHERE id = $1`,
      [id]
    );
    this.logger.log(`[LYDIA-CASHIER] claim released on association ${sanitizeLog(id)}`);
  }

  /**
   * The checks and claim before Lydia is asked to add `userId` (number `phone`) as a `role`: a
   * Business is linked (`LYDIA_NO_BUSINESS`), the person is a member (`LYDIA_CASHIER_NOT_A_MEMBER`)
   * and not already a live cashier (`LYDIA_CASHIER_ALREADY_SET`), a confirmed Responsable exists
   * (`LYDIA_CASHIER_NO_HOLDER`: nobody could remove the cashier otherwise), and the number is not
   * one a live row holds (`LYDIA_CASHIER_PHONE_IN_USE`: Lydia would REPLACE that cashier's rights).
   * A row whose seal does not open counts as holding the number - refused rather than risked.
   */
  async claimAdd(
    id: string,
    input: { userId: string; phone: string; role: string }
  ): Promise<{ vendorToken: string }> {
    this.logger.debug(`[LYDIA-CASHIER] add claim asked on ${sanitizeLog(id)}`);
    if (!E164_RE.test(input.phone) || (input.role !== 'tresorier' && input.role !== 'vendeur')) {
      this.logger.warn(`[LYDIA-CASHIER] add claim refused on ${sanitizeLog(id)}: malformed body`);
      throw new BadRequestException('An E.164 phone and a role (tresorier | vendeur) are required');
    }
    const vendorToken = await this.vendorTokenOrThrow(id);
    if (!(await this.associations.isMember(input.userId, id))) {
      this.logger.warn(`[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: not a member`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_NOT_A_MEMBER,
        message: 'A cashier must be a member of the association',
      });
    }
    const rows = await this.liveRows((s, p) => this.assoRepo.query(s, p), id, vendorToken);
    if (rows.some((row) => row.userId === input.userId)) {
      this.logger.warn(`[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: already a cashier`);
      throw conflict(LYDIA_CASHIER_ALREADY_SET, 'This member already is a cashier');
    }
    this.holderPhoneOrThrow(id, rows);
    for (const row of rows) {
      for (const sealed of [row.phoneSealed, row.previousPhoneSealed]) {
        if (!sealed) continue;
        const phone = this.open(id, sealed, 'a cashier number');
        if (phone === null || phone === input.phone) {
          this.logger.warn(
            `[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: the number is held by a live row` +
              (phone === null ? ' (or its seal does not open)' : '')
          );
          throw conflict(LYDIA_CASHIER_PHONE_IN_USE, 'This number already is a cashier number');
        }
      }
    }
    await this.claim(id, vendorToken, 'add');
    return { vendorToken };
  }

  /**
   * The checks and claim before Lydia is asked to change cashier `cashierId`'s role (a re-add with
   * the new set): the row is live on the current Business (`LYDIA_CASHIER_NOT_FOUND`) and is not
   * the Responsable (`LYDIA_CASHIER_ROLE_FIXED`). Answers its number, opened, for the re-add.
   */
  async claimRoleChange(
    id: string,
    input: { cashierId: string; role: string }
  ): Promise<{ vendorToken: string; phone: string; userId: string }> {
    if (input.role !== 'tresorier' && input.role !== 'vendeur') {
      throw new BadRequestException('role must be tresorier or vendeur');
    }
    const vendorToken = await this.vendorTokenOrThrow(id);
    const rows = await this.liveRows((s, p) => this.assoRepo.query(s, p), id, vendorToken);
    const row = rows.find((r) => r.id === input.cashierId);
    if (!row) {
      this.logger.warn(`[LYDIA-CASHIER] role change refused on ${sanitizeLog(id)}: no such row`);
      throw new NotFoundException({ code: LYDIA_CASHIER_NOT_FOUND, message: 'No such cashier' });
    }
    if (row.role === 'responsable') {
      this.logger.warn(`[LYDIA-CASHIER] role change refused on ${sanitizeLog(id)}: Responsable`);
      throw conflict(LYDIA_CASHIER_ROLE_FIXED, "The Responsable's role is not changed here");
    }
    const phone = this.open(id, row.phoneSealed, "a cashier's number");
    if (!phone) throw new ServiceUnavailableException("The cashier's number cannot be read");
    await this.claim(id, vendorToken, 'role change');
    return { vendorToken, phone, userId: row.userId };
  }

  /**
   * Records what Lydia answered to an add (`cashierId` absent) or a role change (`cashierId`):
   * `confirmed` when the read-back showed exactly the role's rights, UNCONFIRMED otherwise (Lydia
   * holds a cashier anyway). ONE transaction, the association row locked: the Business must still
   * be `vendorToken` (`LYDIA_BUSINESS_CHANGED`); a concurrent add of the same member is refused by
   * the one-live-row-per-member index (`LYDIA_CASHIER_ALREADY_SET`, never a 500). Releases the
   * claim in the same transaction, and on every typed refusal. A NEW cashier confirmed by Lydia is
   * told by a bell row (`LydiaCashierNotifier`, switched off until the floor version).
   */
  async record(
    id: string,
    input: {
      vendorToken: unknown;
      userId: unknown;
      phone: unknown;
      role: unknown;
      addedByUserId: unknown;
      confirmed: unknown;
      cashierId?: unknown;
    }
  ): Promise<LydiaCashierView> {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const vendorToken = text(input.vendorToken);
    const userId = text(input.userId);
    const phone = text(input.phone);
    const role = text(input.role);
    const addedBy = text(input.addedByUserId);
    const cashierId = text(input.cashierId);
    const confirmed = input.confirmed;
    if (
      !vendorToken ||
      !userId ||
      !addedBy ||
      !E164_RE.test(phone) ||
      (role !== 'tresorier' && role !== 'vendeur') ||
      typeof confirmed !== 'boolean'
    ) {
      this.logger.warn(`[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: malformed body`);
      throw new BadRequestException(
        'vendorToken, userId, addedByUserId, an E.164 phone, a role and confirmed are required'
      );
    }
    if (!isSecretBoxConfigured()) {
      this.logger.error(
        `[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: LYDIA_KEY_ENCRYPTION_SECRET is not configured`
      );
      throw new ServiceUnavailableException('Cashier phone storage is not configured');
    }
    let rowId = cashierId;
    try {
      await this.assoRepo.manager.transaction(async (manager: EntityManager) => {
        const asso: Array<{ vendorToken: string | null }> = await manager.query(
          `SELECT "lydiaAccountId" AS "vendorToken" FROM associations WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (asso.length === 0) throw new NotFoundException('Association not found');
        if ((asso[0].vendorToken?.trim() || null) !== vendorToken) {
          this.logger.warn(
            `[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: Business changed`
          );
          throw conflict(LYDIA_BUSINESS_CHANGED, 'The Lydia Business of this association changed');
        }
        if (cashierId) {
          const updated: unknown[] = await manager.query(
            `UPDATE lydia_cashiers
                SET role = $3, "confirmedAt" = CASE WHEN $4 THEN now() END,
                    "addedByUserId" = $5, "addedAt" = now()
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL
                AND role <> 'responsable'
              RETURNING id`,
            [cashierId, id, role, confirmed, addedBy]
          );
          if (returnedCount(updated) === 0) {
            this.logger.warn(`[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: row gone`);
            throw new NotFoundException({
              code: LYDIA_CASHIER_NOT_FOUND,
              message: 'No such cashier',
            });
          }
        } else {
          const inserted: Array<{ id: string }> = await manager.query(
            `INSERT INTO lydia_cashiers
               ("associationId", "vendorToken", "userId", "phoneSealed", "phoneEnd", role,
                "addedByUserId", "confirmedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END)
             RETURNING id`,
            [
              id,
              vendorToken,
              userId,
              sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, id, phone),
              phone.slice(-2),
              role,
              addedBy,
              confirmed,
            ]
          );
          rowId = inserted[0].id;
        }
        await manager.query(
          `UPDATE associations SET "lydiaResponsableStartedAt" = NULL WHERE id = $1`,
          [id]
        );
      });
    } catch (err: unknown) {
      if ((err as { code?: unknown })?.code === '23505') {
        this.logger.warn(
          `[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: a concurrent add of the same member won`
        );
        await this.release(id);
        throw conflict(LYDIA_CASHIER_ALREADY_SET, 'This member already is a cashier');
      }
      if (err instanceof ConflictException || err instanceof NotFoundException) {
        await this.release(id);
      }
      throw err;
    }
    const audit =
      `Lydia cashier ${cashierId ? 'role changed' : 'added'} on association ${sanitizeLog(id)}: ` +
      `user ${sanitizeLog(userId).slice(0, 8)} as ${role}, phone ending ${phone.slice(-2)}, by ` +
      `${sanitizeLog(addedBy).slice(0, 8)}`;
    if (confirmed) {
      this.logger.log(`[AUDIT] ${audit}`);
      if (!cashierId) {
        const asso: Array<{ name: string }> = await this.assoRepo.query(
          `SELECT name FROM associations WHERE id = $1`,
          [id]
        );
        await this.notifier.tellAdded({ id, name: asso[0]?.name ?? '' }, userId);
      }
    } else {
      this.logger.error(`[AUDIT] ${audit} - UNCONFIRMED: Lydia did not confirm the rights`);
    }
    const view = (
      await listLydiaCashiers((s, p) => this.assoRepo.query(s, p), id, vendorToken)
    ).find((row) => row.id === rowId);
    if (!view) throw new Error('the cashier row just written cannot be read back');
    return view;
  }

  /**
   * The checks and claim before Lydia is asked to remove a number of row `cashierId`: `current`
   * (the row's own number) or `previous` (a Responsable's OLD number, after a number change). The
   * row must be live on the current Business (`LYDIA_CASHIER_NOT_FOUND`, also for a `previous` that
   * is not there); the Responsable's CURRENT number is never removed (`LYDIA_CASHIER_LAST_HOLDER`:
   * one Responsable per association, so it is the only number managing cashiers); and a removal
   * needs a CONFIRMED Responsable (`LYDIA_CASHIER_NO_HOLDER`). Answers both
   * numbers, opened, for core-service alone; a seal that does not open is a 503, nothing claimed.
   */
  async claimRevoke(
    id: string,
    input: { cashierId: string; number: LydiaCashierNumber }
  ): Promise<LydiaCashierRevokeTarget> {
    this.logger.debug(`[LYDIA-CASHIER] revoke claim asked on ${sanitizeLog(id)} (${input.number})`);
    const vendorToken = await this.vendorTokenOrThrow(id);
    const rows = await this.liveRows((s, p) => this.assoRepo.query(s, p), id, vendorToken);
    const row = rows.find((r) => r.id === input.cashierId);
    if (!row || (input.number === 'previous' && !row.previousPhoneSealed)) {
      this.logger.warn(`[LYDIA-CASHIER] revoke refused on ${sanitizeLog(id)}: no such number`);
      throw new NotFoundException({ code: LYDIA_CASHIER_NOT_FOUND, message: 'No such cashier' });
    }
    if (input.number === 'current' && row.role === 'responsable') {
      this.logger.warn(
        `[LYDIA-CASHIER] revoke refused on ${sanitizeLog(id)}: the Responsable is the last holder`
      );
      throw conflict(
        LYDIA_CASHIER_LAST_HOLDER,
        'The Responsable is the only one managing the cashiers'
      );
    }
    const holder = this.holderPhoneOrThrow(id, rows);
    const cashierPhone = this.open(
      id,
      input.number === 'previous' ? row.previousPhoneSealed : row.phoneSealed,
      'the number to remove'
    );
    if (!cashierPhone) throw new ServiceUnavailableException('The number cannot be read');
    await this.claim(id, vendorToken, `revoke (${input.number})`);
    return { vendorToken, cashierPhone, actorPhone: holder.phone };
  }

  /**
   * Records a removal's outcome and releases the claim. `verified` (Lydia's re-read showed 0
   * rights): `current` closes the row (`removedAt`, every phone and phone ending cleared, as the
   * unlink does), `previous` clears the old number. Not verified: the row stays live and is
   * FLAGGED (`revokeUnconfirmedAt` / `previousRevokeUnconfirmedAt`, migration 119) - ERROR.
   */
  async recordRevoke(
    id: string,
    input: { cashierId: string; number: LydiaCashierNumber; verified: boolean; actorId: string }
  ): Promise<void> {
    const sql =
      input.number === 'current'
        ? input.verified
          ? `UPDATE lydia_cashiers SET "removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL,
                    "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL,
                    "revokeUnconfirmedAt" = NULL, "previousRevokeUnconfirmedAt" = NULL
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL RETURNING id`
          : `UPDATE lydia_cashiers SET "revokeUnconfirmedAt" = now()
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL RETURNING id`
        : input.verified
          ? `UPDATE lydia_cashiers SET "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL,
                    "previousRevokeUnconfirmedAt" = NULL
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL RETURNING id`
          : `UPDATE lydia_cashiers SET "previousRevokeUnconfirmedAt" = now()
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL RETURNING id`;
    await this.assoRepo.manager.transaction(async (manager: EntityManager) => {
      const written = returnedCount(await manager.query(sql, [input.cashierId, id]));
      await manager.query(
        `UPDATE associations SET "lydiaResponsableStartedAt" = NULL WHERE id = $1`,
        [id]
      );
      const audit =
        `Lydia cashier removal on association ${sanitizeLog(id)}: row ` +
        `${sanitizeLog(input.cashierId).slice(0, 8)} (${input.number} number), by ` +
        `${sanitizeLog(input.actorId).slice(0, 8)}`;
      if (written === 0) {
        this.logger.warn(`[AUDIT] ${audit} - the row was no longer live, nothing written`);
      } else if (input.verified) {
        this.logger.log(`[AUDIT] ${audit} - confirmed by Lydia (0 rights)`);
      } else {
        this.logger.error(
          `[AUDIT] ${audit} - NOT confirmed by Lydia: the row stays live, flagged; Lydia may still list that number`
        );
      }
    });
  }

  /**
   * BEFORE AN ACCOUNT'S ERASURE: asks Lydia (through core-service) to remove every number the
   * account's LIVE cashier rows hold, best effort - an unanswered or unconfirmed removal is logged
   * and the erasure goes on regardless. Each removal needs the association's CONFIRMED
   * Responsable; a Responsable's own current number is never removed (nobody would
   * be left managing the Business) and no row without a confirmed Responsable can be acted on -
   * both are logged and left to the caller's ERROR audit line. Answers the rows (association and
   * Business) whose every number Lydia CONFIRMED removed, which the caller does not accuse. No claim
   * is taken: an erasure never waits on one.
   */
  async revokeBeforeErasure(userId: string): Promise<Set<string>> {
    const who = sanitizeLog(userId).slice(0, 8);
    const rows = (await this.assoRepo.query(
      `SELECT c.id, c."associationId", c."vendorToken", c.role, c."phoneSealed",
              c."previousPhoneSealed", c."confirmedAt"
         FROM lydia_cashiers c
        WHERE c."userId" = $1 AND c."removedAt" IS NULL`,
      [userId]
    )) as Array<LiveRow & { associationId: string; vendorToken: string }>;
    const cleared = new Set<string>();
    for (const row of rows) {
      const where = `association ${sanitizeLog(row.associationId)}`;
      try {
        const all = await this.liveRows(
          (s, p) => this.assoRepo.query(s, p),
          row.associationId,
          row.vendorToken
        );
        const holder = all.find((r) => r.role === 'responsable' && r.confirmedAt != null);
        const actorPhone = holder
          ? this.open(row.associationId, holder.phoneSealed, "the Responsable's number")
          : null;
        if (!actorPhone) {
          this.logger.error(
            `[LYDIA-CASHIER] erasure of user=${who}: ${where} has no confirmed Responsable ` +
              `- nothing removed at Lydia`
          );
          continue;
        }
        const targets: Array<string | null> = [];
        if (row.role !== 'responsable') targets.push(row.phoneSealed);
        if (row.previousPhoneSealed) targets.push(row.previousPhoneSealed);
        let allVerified = row.role !== 'responsable';
        for (const sealed of targets) {
          const cashierPhone = this.open(row.associationId, sealed, 'the number to remove');
          const verified = cashierPhone
            ? await this.revokeThroughCore(
                row.associationId,
                row.vendorToken,
                actorPhone,
                cashierPhone
              )
            : false;
          allVerified = allVerified && verified;
        }
        if (row.role === 'responsable') {
          this.logger.error(
            `[LYDIA-CASHIER] erasure of user=${who}: the Responsable of ${where} - their current ` +
              `number is not removed at Lydia (nobody else manages the Business)`
          );
        }
        if (allVerified) cleared.add(`${row.associationId}:${row.vendorToken}`);
      } catch (err: unknown) {
        this.logger.error(
          `[LYDIA-CASHIER] erasure of user=${who}: the removal on ${where} failed - erasure goes on`,
          describeHttpError(err as Error)
        );
      }
    }
    return cleared;
  }

  /** One removal through core-service's internal route; false on any failure, never a throw. */
  private async revokeThroughCore(
    associationId: string,
    vendorToken: string,
    actorPhone: string,
    cashierPhone: string
  ): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.httpService.post<{ verified: boolean; held: number | null }>(
          coreUrl('payments/lydia-cashier-revoke-internal'),
          { associationId, vendorToken, actorPhone, cashierPhone },
          { ...internalCoreRequestConfig(), timeout: ERASURE_REVOKE_TIMEOUT_MS }
        )
      );
      const verified = res.data?.verified === true;
      if (verified) {
        this.logger.log(
          `[LYDIA-CASHIER] erasure: number ending ${cashierPhone.slice(-2)} removed at Lydia on ` +
            `association ${sanitizeLog(associationId)} (confirmed, 0 rights)`
        );
      } else {
        this.logger.error(
          `[LYDIA-CASHIER] erasure: number ending ${cashierPhone.slice(-2)} on association ` +
            `${sanitizeLog(associationId)} - removal NOT confirmed (held=${String(res.data?.held)})`
        );
      }
      return verified;
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-CASHIER] erasure: removal on association ${sanitizeLog(associationId)} got no ` +
          `answer from core-service - erasure goes on`,
        describeHttpError(err as Error)
      );
      return false;
    }
  }
}
