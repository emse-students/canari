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
  type LydiaCashierRole,
  type LydiaCashierView,
} from './lydia-cashiers-list';
import {
  LYDIA_CASHIER_NUMBER_CHANGED,
  LYDIA_CASHIER_PHONE_IN_USE,
  claimLost,
  claimTokenOf,
  clearClaim,
  confirmedOf,
  lockAssociation,
  numberHeldBy,
  writeClaim,
} from './lydia-cashier-claim';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import { describeHttpError } from '../common/http-error-log';

/** The `code` (409) of a cashier operation while another one on the association is in flight. */
export const LYDIA_CASHIER_IN_FLIGHT = 'LYDIA_CASHIER_IN_FLIGHT';
/** The `code` (400) of a cashier who is not a member of the association. */
export const LYDIA_CASHIER_NOT_A_MEMBER = 'LYDIA_CASHIER_NOT_A_MEMBER';
/** The `code` (409) of adding a member who already is a live cashier of the association. */
export const LYDIA_CASHIER_ALREADY_SET = 'LYDIA_CASHIER_ALREADY_SET';
/** The `code` (409) when the association has no CONFIRMED Responsable: no cashier step runs before one. */
export const LYDIA_CASHIER_NO_RESPONSABLE = 'LYDIA_CASHIER_NO_RESPONSABLE';
/** The `code` (409) of removing the Responsable's current number: it is managed by its own step. */
export const LYDIA_CASHIER_RESPONSABLE_NUMBER = 'LYDIA_CASHIER_RESPONSABLE_NUMBER';
/** The `code` (404) of a cashier row (or other number) that is not live on the current Business. */
export const LYDIA_CASHIER_NOT_FOUND = 'LYDIA_CASHIER_NOT_FOUND';
/** The `code` (409) of changing the Responsable's role: that is lot 2's step, never a role change. */
export const LYDIA_CASHIER_ROLE_FIXED = 'LYDIA_CASHIER_ROLE_FIXED';
/** core-service's `code` (409) of an association with no Business linked, reused for the cashier steps. */
export const LYDIA_NO_BUSINESS = 'LYDIA_NO_BUSINESS';
export { LYDIA_CASHIER_NUMBER_CHANGED, LYDIA_CASHIER_PHONE_IN_USE };

/** What a cashier phone must look like: E.164, as core-service validated it. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** How long one erasure removal may take at core-service before it is given up (best effort). */
export const ERASURE_REVOKE_TIMEOUT_MS = 30_000;

/** What the call needs from this service, and the claim. */
export interface LydiaCashierRevokeTarget {
  vendorToken: string;
  cashierPhone: string;
  contextPhone: string;
  claimToken: string;
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

/** The live rows of a Business, LOCKED by the transaction that reads them. */
const LIVE_ROWS_SQL = `SELECT id, "userId", role, "phoneSealed", "previousPhoneSealed", "confirmedAt"
  FROM lydia_cashiers
 WHERE "associationId" = $1 AND "vendorToken" = $2 AND "removedAt" IS NULL
 ORDER BY id
 FOR UPDATE`;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

/** The claim token of a body, or the 400 that says it is missing. */
function requiredClaimToken(value: unknown): string {
  const token = claimTokenOf(value);
  if (!token) throw new BadRequestException('claimToken is required');
  return token;
}

/**
 * THE CASHIERS OF AN ASSOCIATION'S LYDIA BUSINESS BEYOND THE RESPONSABLE (Lydia enrolment lot 3):
 * the checks and the claim before core-service asks Lydia anything, the record of what Lydia
 * answered, and the removal before an account's erasure. Lydia itself is only ever called by
 * core-service; this service owns the rows, the sealed numbers and the one claim every cashier
 * operation of an association takes, the Responsable's step included (`lydia-cashier-claim.ts`) -
 * so two operations on the cashiers of one Business never reach Lydia together. Every claim is taken
 * in the transaction that LOCKS the rows its checks read and opens the numbers it answers, and every
 * record re-opens the number it acts on in its own locked transaction: an operation addressed to one
 * number never lands on another. Phones are never logged.
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

  /**
   * The CONFIRMED Responsable's row and current number, opened. The typed 409
   * `LYDIA_CASHIER_NO_RESPONSABLE` when there is none (or it is not confirmed), a 503 when its seal does
   * not open.
   */
  private confirmedResponsableOrThrow(
    id: string,
    rows: LiveRow[]
  ): { row: LiveRow; phone: string } {
    const holder = rows.find((row) => row.role === 'responsable' && row.confirmedAt != null);
    if (!holder) {
      this.logger.warn(`[LYDIA-CASHIER] refused on ${sanitizeLog(id)}: no confirmed Responsable`);
      throw conflict(
        LYDIA_CASHIER_NO_RESPONSABLE,
        'The Responsable must be confirmed by Lydia first'
      );
    }
    const phone = this.open(id, holder.phoneSealed, "the Responsable's number");
    if (!phone) throw new ServiceUnavailableException("The Responsable's number cannot be read");
    return { row: holder, phone };
  }

  /**
   * THE claim of a cashier operation, in ONE transaction: the association row is locked, its
   * Business read (`LYDIA_NO_BUSINESS` when none), the live rows of that Business locked and handed
   * to `check` - whose typed refusals come first - and only then the claim written with a new token
   * (the typed 409 `LYDIA_CASHIER_IN_FLIGHT` while another operation holds it). What `check` read
   * and opened is therefore what the operation acts on. Answers `check`'s result, the Business and
   * the token.
   */
  private async claimWithin<T extends object>(
    id: string,
    what: string,
    check: (vendorToken: string, rows: LiveRow[]) => T
  ): Promise<T & { vendorToken: string; claimToken: string }> {
    return this.assoRepo.manager.transaction(async (manager: EntityManager) => {
      const asso = await lockAssociation(manager, id);
      if (!asso) throw new NotFoundException('Association not found');
      if (!asso.vendorToken) {
        this.logger.warn(
          `[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: no Business linked`
        );
        throw conflict(LYDIA_NO_BUSINESS, 'No Lydia Business is linked to this association');
      }
      const rows = (await manager.query(LIVE_ROWS_SQL, [id, asso.vendorToken])) as LiveRow[];
      const result = check(asso.vendorToken, rows);
      if (asso.claimed) {
        this.logger.warn(
          `[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: another cashier operation is in flight`
        );
        throw conflict(LYDIA_CASHIER_IN_FLIGHT, 'Another cashier operation is in flight');
      }
      const claimToken = await writeClaim(manager, id);
      this.logger.log(`[LYDIA-CASHIER] ${what} claimed on association ${sanitizeLog(id)}`);
      return { ...result, vendorToken: asso.vendorToken, claimToken };
    });
  }

  /**
   * Releases the claim after an outcome core-service knows, when it still carries `claimToken`;
   * never on an unknown add. Answers whether it was released.
   */
  async release(id: string, claimToken: string): Promise<boolean> {
    const released = await clearClaim((s, p) => this.assoRepo.query(s, p), id, claimToken);
    if (released) {
      this.logger.log(`[LYDIA-CASHIER] claim released on association ${sanitizeLog(id)}`);
    } else {
      this.logger.warn(
        `[LYDIA-CASHIER] release on association ${sanitizeLog(id)} ignored: the claim no longer ` +
          `carries that token`
      );
    }
    return released;
  }

  /**
   * The checks and claim before Lydia is asked to add `userId` (number `phone`) as a `role`: a
   * Business is linked (`LYDIA_NO_BUSINESS`), the person is a member (`LYDIA_CASHIER_NOT_A_MEMBER`)
   * and not already a live cashier (`LYDIA_CASHIER_ALREADY_SET`), a confirmed Responsable exists
   * (`LYDIA_CASHIER_NO_RESPONSABLE`: no cashier is added before one), and the number is not
   * one a live row holds (`LYDIA_CASHIER_PHONE_IN_USE`: Lydia would REPLACE that cashier's rights).
   * A row whose seal does not open counts as holding the number - refused rather than risked.
   */
  async claimAdd(
    id: string,
    input: { userId: string; phone: string; role: string }
  ): Promise<{ vendorToken: string; claimToken: string }> {
    this.logger.debug(`[LYDIA-CASHIER] add claim asked on ${sanitizeLog(id)}`);
    if (!E164_RE.test(input.phone) || (input.role !== 'tresorier' && input.role !== 'vendeur')) {
      this.logger.warn(`[LYDIA-CASHIER] add claim refused on ${sanitizeLog(id)}: malformed body`);
      throw new BadRequestException('An E.164 phone and a role (tresorier | vendeur) are required');
    }
    if (!(await this.associations.isMember(input.userId, id))) {
      this.logger.warn(`[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: not a member`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_NOT_A_MEMBER,
        message: 'A cashier must be a member of the association',
      });
    }
    const { vendorToken, claimToken } = await this.claimWithin(id, 'add', (_vendor, rows) => {
      if (rows.some((row) => row.userId === input.userId)) {
        this.logger.warn(`[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: already a cashier`);
        throw conflict(LYDIA_CASHIER_ALREADY_SET, 'This member already is a cashier');
      }
      this.confirmedResponsableOrThrow(id, rows);
      const match = numberHeldBy(
        rows.flatMap((row) => [row.phoneSealed, row.previousPhoneSealed]),
        input.phone,
        (sealed) => this.open(id, sealed, 'a cashier number')
      );
      if (match) {
        this.logger.warn(
          `[LYDIA-CASHIER] add refused on ${sanitizeLog(id)}: the number is held by a live row` +
            (match === 'unreadable' ? ' (or its seal does not open)' : '')
        );
        throw conflict(LYDIA_CASHIER_PHONE_IN_USE, 'This number already is a cashier number');
      }
      return {};
    });
    return { vendorToken, claimToken };
  }

  /**
   * The checks and claim before Lydia is asked to change cashier `cashierId`'s role (a re-add with
   * the new set): the row is live on the current Business (`LYDIA_CASHIER_NOT_FOUND`) and is not
   * the Responsable (`LYDIA_CASHIER_ROLE_FIXED`), and its number is not one of the Responsable's
   * (`LYDIA_CASHIER_PHONE_IN_USE`: the re-add would REPLACE the Responsable's rights with the role's;
   * a seal that does not open counts as one). Answers its number, opened, for the re-add.
   */
  async claimRoleChange(
    id: string,
    input: { cashierId: string; role: string }
  ): Promise<{ vendorToken: string; phone: string; userId: string; claimToken: string }> {
    if (input.role !== 'tresorier' && input.role !== 'vendeur') {
      throw new BadRequestException('role must be tresorier or vendeur');
    }
    return this.claimWithin(id, 'role change', (_vendor, rows) => {
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
      const match = numberHeldBy(
        rows
          .filter((r) => r.role === 'responsable')
          .flatMap((r) => [r.phoneSealed, r.previousPhoneSealed]),
        phone,
        (sealed) => this.open(id, sealed, "a Responsable's number")
      );
      if (match) {
        this.logger.error(
          `[LYDIA-CASHIER] role change refused on ${sanitizeLog(id)}: the row's number is ` +
            `the Responsable's` +
            (match === 'unreadable' ? ' (or its seal does not open)' : '')
        );
        throw conflict(LYDIA_CASHIER_PHONE_IN_USE, 'This number is the Responsable number');
      }
      return { phone, userId: row.userId };
    });
  }

  /**
   * Records what Lydia answered to an add (`cashierId` absent) or a role change (`cashierId`),
   * under the operation's claim (`claimToken`; `LYDIA_CASHIER_CLAIM_LOST` when the association's
   * claim no longer carries it). `confirmed` - an explicit boolean (`LYDIA_CASHIER_CONFIRMED_REQUIRED`)
   * - is true when the read-back showed exactly the role's rights; UNCONFIRMED otherwise (Lydia holds
   * a cashier anyway). ONE transaction, the association row and the cashier row locked: the Business
   * must still be `vendorToken` (`LYDIA_BUSINESS_CHANGED`); a role change applies only while the
   * row's number is still `phone` (`LYDIA_CASHIER_NUMBER_CHANGED`) and clears a removal flag (the
   * number holds the new role's rights again); a concurrent add of the same member is refused by the
   * one-live-row-per-member index (`LYDIA_CASHIER_ALREADY_SET`, never a 500). Releases the claim in
   * the same transaction, and on every typed refusal. A NEW cashier confirmed by Lydia is told by a
   * bell row (`LydiaCashierNotifier`, switched off until the floor version).
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
      claimToken: unknown;
    }
  ): Promise<LydiaCashierView> {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const vendorToken = text(input.vendorToken);
    const userId = text(input.userId);
    const phone = text(input.phone);
    const role = text(input.role);
    const addedBy = text(input.addedByUserId);
    const cashierId = text(input.cashierId);
    const claimToken = requiredClaimToken(input.claimToken);
    let confirmed: boolean;
    try {
      if (
        !vendorToken ||
        !userId ||
        !addedBy ||
        !E164_RE.test(phone) ||
        (role !== 'tresorier' && role !== 'vendeur')
      ) {
        this.logger.warn(`[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: malformed body`);
        throw new BadRequestException(
          'vendorToken, userId, addedByUserId, an E.164 phone and a role are required'
        );
      }
      confirmed = confirmedOf(input.confirmed);
    } catch (err: unknown) {
      // A malformed record is a typed outcome too: its claim is released, never left stuck.
      await this.release(id, claimToken);
      throw err;
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
        await this.lockForRecord(manager, id, vendorToken, claimToken, 'record');
        if (cashierId) {
          const rows: Array<{ phoneSealed: string | null }> = await manager.query(
            `SELECT "phoneSealed" FROM lydia_cashiers
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL
                AND role <> 'responsable'
              FOR UPDATE`,
            [cashierId, id]
          );
          if (rows.length === 0) {
            this.logger.warn(`[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: row gone`);
            throw new NotFoundException({
              code: LYDIA_CASHIER_NOT_FOUND,
              message: 'No such cashier',
            });
          }
          this.assertSameNumber(id, rows[0].phoneSealed, phone, 'role change');
          await manager.query(
            `UPDATE lydia_cashiers
                SET role = $3, "confirmedAt" = CASE WHEN $4 THEN now() END,
                    "revokeUnconfirmedAt" = NULL,
                    "addedByUserId" = $5, "addedAt" = now()
              WHERE id = $1 AND "associationId" = $2`,
            [cashierId, id, role, confirmed, addedBy]
          );
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
        await clearClaim((s, p) => manager.query(s, p), id, claimToken);
      });
    } catch (err: unknown) {
      if ((err as { code?: unknown })?.code === '23505') {
        this.logger.warn(
          `[LYDIA-CASHIER] record refused on ${sanitizeLog(id)}: a concurrent add of the same member won`
        );
        await this.release(id, claimToken);
        throw conflict(LYDIA_CASHIER_ALREADY_SET, 'This member already is a cashier');
      }
      if (err instanceof ConflictException || err instanceof NotFoundException) {
        await this.release(id, claimToken);
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
   * The association-row checks every record makes in its transaction: the row exists and is
   * locked, its claim carries `claimToken` (`LYDIA_CASHIER_CLAIM_LOST`, at ERROR: Lydia may have
   * changed something this record then does not keep), and its Business is `vendorToken` when
   * given (`LYDIA_BUSINESS_CHANGED`).
   */
  private async lockForRecord(
    manager: EntityManager,
    id: string,
    vendorToken: string | null,
    claimToken: string,
    what: string
  ): Promise<void> {
    const asso = await lockAssociation(manager, id);
    if (!asso) throw new NotFoundException('Association not found');
    if (asso.claimToken !== claimToken) {
      this.logger.error(
        `[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: the claim no longer carries its ` +
          `token - Lydia's answer is not recorded`
      );
      throw claimLost();
    }
    if (vendorToken !== null && asso.vendorToken !== vendorToken) {
      this.logger.warn(`[LYDIA-CASHIER] ${what} refused on ${sanitizeLog(id)}: Business changed`);
      throw conflict('LYDIA_BUSINESS_CHANGED', 'The Lydia Business of this association changed');
    }
  }

  /**
   * Refuses (`LYDIA_CASHIER_NUMBER_CHANGED`, at ERROR) unless `sealed`, opened HERE inside the
   * locked transaction, is `phone`: what Lydia was asked about is recorded on that number only.
   */
  private assertSameNumber(id: string, sealed: string | null, phone: string, what: string): void {
    if (this.open(id, sealed, 'the number acted on') === phone) return;
    this.logger.error(
      `[LYDIA-CASHIER] ${what} on ${sanitizeLog(id)} NOT recorded: the row no longer holds the ` +
        `number Lydia was asked about`
    );
    throw conflict(
      LYDIA_CASHIER_NUMBER_CHANGED,
      'The cashier number changed while Lydia was being asked'
    );
  }

  /**
   * The checks and claim before Lydia is asked to remove a number of row `cashierId`: `current`
   * (the row's own number) or `previous` (a Responsable's OTHER number). The row must be live on
   * the current Business (`LYDIA_CASHIER_NOT_FOUND`, also for a `previous` that is not there); the
   * Responsable's CURRENT number is never removed, by its own row or through another row holding the
   * same number (`LYDIA_CASHIER_RESPONSABLE_NUMBER`); the association must have a
   * CONFIRMED Responsable (`LYDIA_CASHIER_NO_RESPONSABLE`). The numbers the removal needs are opened inside
   * the transaction that locks the rows and takes the claim, and answered for core-service alone with
   * the claim token; a seal that does not open is a 503, nothing claimed.
   */
  async claimRevoke(
    id: string,
    input: { cashierId: string; number: LydiaCashierNumber }
  ): Promise<LydiaCashierRevokeTarget> {
    this.logger.debug(`[LYDIA-CASHIER] revoke claim asked on ${sanitizeLog(id)} (${input.number})`);
    return this.claimWithin(id, `revoke (${input.number})`, (_vendor, rows) => {
      const row = rows.find((r) => r.id === input.cashierId);
      if (!row || (input.number === 'previous' && !row.previousPhoneSealed)) {
        this.logger.warn(`[LYDIA-CASHIER] revoke refused on ${sanitizeLog(id)}: no such number`);
        throw new NotFoundException({ code: LYDIA_CASHIER_NOT_FOUND, message: 'No such cashier' });
      }
      if (input.number === 'current' && row.role === 'responsable') {
        this.logger.warn(
          `[LYDIA-CASHIER] revoke refused on ${sanitizeLog(id)}: the Responsable's current number`
        );
        throw conflict(
          LYDIA_CASHIER_RESPONSABLE_NUMBER,
          "The Responsable's current number is not removed"
        );
      }
      const responsable = this.confirmedResponsableOrThrow(id, rows);
      const cashierPhone = this.open(
        id,
        input.number === 'previous' ? row.previousPhoneSealed : row.phoneSealed,
        'the number to remove'
      );
      if (!cashierPhone) throw new ServiceUnavailableException('The number cannot be read');
      if (cashierPhone === responsable.phone) {
        this.logger.error(
          `[LYDIA-CASHIER] revoke refused on ${sanitizeLog(id)}: the number to remove is the ` +
            `Responsable's current number`
        );
        throw conflict(
          LYDIA_CASHIER_RESPONSABLE_NUMBER,
          "The Responsable's current number is not removed"
        );
      }
      return { cashierPhone, contextPhone: responsable.phone };
    });
  }

  /**
   * Records a removal's outcome under its claim and releases it, in ONE transaction locking the
   * association row and the cashier row: the claim must carry `claimToken`
   * (`LYDIA_CASHIER_CLAIM_LOST`), and the row's `number` must still be `cashierPhone`, opened here
   * (`LYDIA_CASHIER_NUMBER_CHANGED`: nothing is written about another number). `verified` (Lydia's
   * re-read showed 0 rights): `current` closes the row (`removedAt`, every phone and phone ending
   * cleared, as the unlink does), `previous` clears the other number. Not verified: the row stays
   * live and is FLAGGED (`revokeUnconfirmedAt` / `previousRevokeUnconfirmedAt`, migration 119) - ERROR.
   */
  async recordRevoke(
    id: string,
    input: {
      cashierId: string;
      number: LydiaCashierNumber;
      verified: boolean;
      actorId: string;
      cashierPhone: string;
      claimToken: string;
    }
  ): Promise<void> {
    const sql =
      input.number === 'current'
        ? input.verified
          ? `UPDATE lydia_cashiers SET "removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL,
                    "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL,
                    "revokeUnconfirmedAt" = NULL, "previousRevokeUnconfirmedAt" = NULL
              WHERE id = $1 AND "associationId" = $2 RETURNING id`
          : `UPDATE lydia_cashiers SET "revokeUnconfirmedAt" = now()
              WHERE id = $1 AND "associationId" = $2 RETURNING id`
        : input.verified
          ? `UPDATE lydia_cashiers SET "previousPhoneSealed" = NULL, "previousPhoneEnd" = NULL,
                    "previousRevokeUnconfirmedAt" = NULL
              WHERE id = $1 AND "associationId" = $2 RETURNING id`
          : `UPDATE lydia_cashiers SET "previousRevokeUnconfirmedAt" = now()
              WHERE id = $1 AND "associationId" = $2 RETURNING id`;
    const audit =
      `Lydia cashier removal on association ${sanitizeLog(id)}: row ` +
      `${sanitizeLog(input.cashierId).slice(0, 8)} (${input.number} number), by ` +
      `${sanitizeLog(input.actorId).slice(0, 8)}`;
    try {
      await this.assoRepo.manager.transaction(async (manager: EntityManager) => {
        await this.lockForRecord(manager, id, null, input.claimToken, 'removal record');
        const rows: Array<{ phoneSealed: string | null; previousPhoneSealed: string | null }> =
          await manager.query(
            `SELECT "phoneSealed", "previousPhoneSealed" FROM lydia_cashiers
              WHERE id = $1 AND "associationId" = $2 AND "removedAt" IS NULL FOR UPDATE`,
            [input.cashierId, id]
          );
        if (rows.length === 0) {
          this.logger.warn(`[AUDIT] ${audit} - the row was no longer live, nothing written`);
        } else {
          this.assertSameNumber(
            id,
            input.number === 'previous' ? rows[0].previousPhoneSealed : rows[0].phoneSealed,
            input.cashierPhone,
            'removal'
          );
          await manager.query(sql, [input.cashierId, id]);
          if (input.verified) {
            this.logger.log(`[AUDIT] ${audit} - confirmed by Lydia (0 rights)`);
          } else {
            this.logger.error(
              `[AUDIT] ${audit} - NOT confirmed by Lydia: the row stays live, flagged; Lydia may still list that number`
            );
          }
        }
        await clearClaim((s, p) => manager.query(s, p), id, input.claimToken);
      });
    } catch (err: unknown) {
      if (err instanceof ConflictException) await this.release(id, input.claimToken);
      throw err;
    }
  }

  /**
   * BEFORE AN ACCOUNT'S ERASURE: asks Lydia (through core-service) to remove every number the
   * account's LIVE cashier rows hold, best effort - an unanswered or unconfirmed removal is logged
   * and the erasure goes on regardless. Per association it takes the cashier claim WITHOUT waiting
   * (another operation in flight: that association is skipped, at ERROR), so the numbers opened
   * under that lock are the numbers removed. A Responsable's own current number is never removed,
   * nor any number another live row holds; no row without a confirmed Responsable can be acted on -
   * all logged and left to the caller's ERROR audit line. Answers the rows (association and Business)
   * whose every number Lydia CONFIRMED removed, which the caller does not accuse. Never throws.
   */
  async revokeBeforeErasure(userId: string): Promise<Set<string>> {
    const who = sanitizeLog(userId).slice(0, 8);
    const cleared = new Set<string>();
    let rows: Array<{ id: string; associationId: string; vendorToken: string }>;
    try {
      rows = (await this.assoRepo.query(
        `SELECT c.id, c."associationId", c."vendorToken"
           FROM lydia_cashiers c
          WHERE c."userId" = $1 AND c."removedAt" IS NULL`,
        [userId]
      )) as Array<{ id: string; associationId: string; vendorToken: string }>;
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-CASHIER] erasure of user=${who}: the cashier rows could not be read - erasure goes on`,
        describeHttpError(err as Error)
      );
      return cleared;
    }
    for (const mine of rows) {
      const where = `association ${sanitizeLog(mine.associationId)}`;
      let claimToken: string | null = null;
      try {
        const plan = await this.claimWithin(mine.associationId, 'erasure', (vendorToken, all) =>
          this.erasurePlan(mine, vendorToken, all, who, where)
        );
        claimToken = plan.claimToken;
        let allVerified = plan.complete;
        for (const cashierPhone of plan.targets) {
          const verified = await this.revokeThroughCore(
            mine.associationId,
            plan.vendorToken,
            plan.contextPhone,
            cashierPhone
          );
          allVerified = allVerified && verified;
        }
        if (allVerified) cleared.add(`${mine.associationId}:${plan.vendorToken}`);
      } catch (err: unknown) {
        this.logger.error(
          `[LYDIA-CASHIER] erasure of user=${who}: the removal on ${where} failed or was skipped ` +
            `- erasure goes on`,
          describeHttpError(err as Error)
        );
      } finally {
        if (claimToken) {
          try {
            await this.release(mine.associationId, claimToken);
          } catch (err: unknown) {
            this.logger.error(
              `[LYDIA-CASHIER] erasure of user=${who}: the claim on ${where} could not be ` +
                `released - a global admin clears it`,
              describeHttpError(err as Error)
            );
          }
        }
      }
    }
    return cleared;
  }

  /**
   * What an erasure removes for row `mine`, read under the claim's lock: its numbers, each opened
   * here, minus the Responsable's current number and any number another live row holds, each skip
   * said at ERROR. `complete` is false when anything is
   * left behind. Throws - so no claim is taken - when the row is gone or there is no confirmed
   * Responsable (`LYDIA_CASHIER_NO_RESPONSABLE`).
   */
  private erasurePlan(
    mine: { id: string; associationId: string; vendorToken: string },
    vendorToken: string,
    all: LiveRow[],
    who: string,
    where: string
  ): { targets: string[]; contextPhone: string; complete: boolean } {
    const id = mine.associationId;
    const row = all.find((r) => r.id === mine.id);
    if (!row || vendorToken !== mine.vendorToken) {
      throw new NotFoundException(`the row is no longer live on the Business of ${where}`);
    }
    const responsable = this.confirmedResponsableOrThrow(id, all);
    const othersHold = new Set<string>([responsable.phone]);
    for (const other of all) {
      if (other.id === row.id) continue;
      for (const sealed of [other.phoneSealed, other.previousPhoneSealed]) {
        const phone = this.open(id, sealed, 'another cashier number');
        if (phone) othersHold.add(phone);
      }
    }
    let complete = row.role !== 'responsable';
    if (!complete) {
      this.logger.error(
        `[LYDIA-CASHIER] erasure of user=${who}: the Responsable of ${where} - their current ` +
          `number is not removed at Lydia`
      );
    }
    const targets: string[] = [];
    const mineSealed =
      row.role === 'responsable'
        ? [row.previousPhoneSealed]
        : [row.phoneSealed, row.previousPhoneSealed];
    for (const sealed of mineSealed) {
      if (!sealed) continue;
      const phone = this.open(id, sealed, 'the number to remove');
      if (!phone || othersHold.has(phone)) {
        this.logger.error(
          `[LYDIA-CASHIER] erasure of user=${who}: a number on ${where} is not removed - ` +
            (phone ? 'another live cashier holds it' : 'its seal does not open')
        );
        complete = false;
        continue;
      }
      targets.push(phone);
    }
    return { targets, contextPhone: responsable.phone, complete };
  }

  /** One removal through core-service's internal route; false on any failure, never a throw. */
  private async revokeThroughCore(
    associationId: string,
    vendorToken: string,
    contextPhone: string,
    cashierPhone: string
  ): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.httpService.post<{ verified: boolean; held: number | null }>(
          coreUrl('internal/lydia-cashiers/revoke'),
          { associationId, vendorToken, contextPhone, cashierPhone },
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
