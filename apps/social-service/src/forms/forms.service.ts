/* eslint-disable */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, type EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Form } from './entities/form.entity';
import { retireForms } from './retire-forms';
import {
  PENDING_HOLD_CUTOFF_SQL,
  PAYMENT_REQUEST_LIFETIME_SECONDS,
  PREVIOUS_PAYMENT_OPEN,
  ALREADY_ANSWERED,
  answerHoldingWhere,
  pickShownAnswer,
  SETTLED_PAYMENT_STATUSES,
  CONFIRMABLE_PAYMENT_STATUSES,
  LYDIA_REQUEST_UUID_RE,
  SETTLED_REFUSED_REQUEST_STATES,
  livePendingWhere,
  lockFormSeats,
  overCapacityFirst,
  seatHoldingWhere,
  toRequestState,
  type RequestState,
} from './seat-hold';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import axios from 'axios';
import * as ExcelJS from 'exceljs';
import { answerText, type AnswerQuestion, type AnswerWords } from './answer-text';
import type { ExportLabels } from './export-labels';
import {
  FormFilesService,
  fileAnswersOf,
  hasFileQuestion,
  type AnswerFileState,
} from './form-files.service';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { resolveCheckoutCallbackUrl } from '../common/checkout-callback-url';
import { withSubmissionReturnKey } from './return-url-key';
import {
  GUEST_RECEIPT_NOT_FOUND,
  guestReference,
  hashGuestReceipt,
  isGuestReceiptShape,
  newGuestReceipt,
  toGuestReceiptView,
  type GuestReceiptView,
} from './guest-receipt';
import { GUEST_PENDING_CEILING, GUEST_PENDING_LIMIT, guestVisitorKey } from './guest-visitor';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { toManagerView, toSubmitterView } from './submission.projection';
import {
  bucketFor,
  dimensionsNeedProfile,
  matchesCondition,
  needsProfile,
  type AudienceCondition,
  type PricingFacts,
} from '../pricing/audience';
import {
  pricedQuestionIds,
  pricingViewFor,
  resolveCellPrice,
  type CellValue,
  type PriceMatrix,
  type PricingView,
} from '../pricing/price-matrix';
import { criteriaContextFor, parseAudienceCondition, parsePriceMatrix } from '../pricing/validate';
import {
  answerSelections,
  normaliseCondition,
  profileHiddenItemIds,
  visibleItemIds,
  type ConditionalItem,
} from './visibility';
import {
  assertDeclaredOptionAnswers,
  assertUniqueItemIds,
  decidesPrice,
  freeFallbackCells,
  type PricedItem,
} from './answer-options';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import {
  amountOutOfRange,
  mapCorePaymentError,
  PROVIDER_MAX_AMOUNT_CENTS,
  PROVIDER_MIN_AMOUNT_CENTS,
} from '../common/core-payment-error';
import { PAYMENTS_DISABLED_MESSAGE } from '../associations/payment-delegation.util';
import { FormOrganiserAlertService } from './organiser-alert.service';

/** Generates a short random ID with the given prefix, e.g. "item_a3b9x1". */
function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('base64url')}`;
}

/** True when the form is configured to collect money for an association recipient. */
function formRequiresStripeReadyAssociation(input: {
  associationId?: string;
  basePrice?: number;
  priceMatrix?: unknown;
  requiresPayment?: boolean;
}): boolean {
  if (!input.associationId?.trim()) return false;
  if ((input.basePrice ?? 0) > 0 || input.requiresPayment) return true;
  // A grid can charge while `basePrice` is 0 - that is the whole point of a cell. Any non-zero cell
  // makes this a paid form, so the beneficiary has to be able to receive the money.
  const cells = (input.priceMatrix as PriceMatrix | null | undefined)?.cells;
  return !!cells && Object.values(cells).some((c) => (c ?? 0) > 0);
}

/**
 * Whether a form can charge a submitter: payment switched on, a base price, a grid cell above 0, or
 * a choice option with a supplement - each of which `submit` turns into a total above 0.
 */
function chargesMoney(input: CreateFormDto): boolean {
  if (input.requiresPayment === true || (input.basePrice ?? 0) > 0) return true;
  const cells = (input.priceMatrix as PriceMatrix | null | undefined)?.cells;
  if (cells && Object.values(cells).some((c) => (c ?? 0) > 0)) return true;
  return ((input.items ?? []) as PricedItem[]).some((item) => decidesPrice(item, new Set()));
}

/**
 * Whether a form takes money or grants something. An anonymous form refuses both: a payment names
 * its payer to the processor and to the submission, the identity it promised not to keep.
 */
function takesMoneyOrGrants(input: CreateFormDto): boolean {
  return (
    input.requiresPayment === true ||
    (input.basePrice ?? 0) > 0 ||
    input.priceMatrix != null ||
    input.allowCashPayment === true ||
    input.grantsCotisation === true
  );
}

/** Whether a question is shown or hidden by who the person IS - a promo, a formation, a cotisation. */
function hasProfileCriterion(item: any): boolean {
  const condition = normaliseCondition(item);
  if (!condition) return false;
  const { answer: _answer, ...profileOnly } = condition;
  return Object.keys(profileOnly).length > 0;
}

/** Where a submission comes from: a signed-in member, or a guest on a public form's link. */
export type SubmitOrigin = 'member' | 'guest';

/** Dynamic form engine: creation, submission (with optional online checkout), exports, and submission lifecycle. */
/** The part of a form item the XLSX export needs: a column header, its key, and how to read an answer. */
type FormItemLike = AnswerQuestion & { id: string; label: string };

/** The durable flags a landed payment's effects are claimed through (migrations 084 and 102). */
type FulfilmentFlag = 'cotisationGrantedAt' | 'purchaseRecordedAt' | 'organiserNotifiedAt';

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
    @InjectRepository(FormReminder) private readonly reminderRepo: Repository<FormReminder>,
    private readonly configService: ConfigService,
    private readonly associationsService: AssociationsService,
    private readonly userTagService: UserTagService,
    private readonly purchaseRecordService: PurchaseRecordService,
    private readonly pricingFacts: PricingFactsService,
    @InjectRepository(FormRespondent) private readonly respondentRepo: Repository<FormRespondent>,
    private readonly formFiles: FormFilesService,
    private readonly organiserAlert: FormOrganiserAlertService
  ) {}

  /**
   * Paid forms linked to an association require its payment onboarding to be complete.
   * @throws BadRequestException when the association cannot receive payments yet
   */
  private async assertPaidFormAssociationReady(input: {
    associationId?: string;
    basePrice?: number;
    /** A grid can charge while `basePrice` is 0, so it counts towards "this form takes money". */
    priceMatrix?: unknown;
    requiresPayment?: boolean;
  }): Promise<void> {
    if (!formRequiresStripeReadyAssociation(input)) return;
    await this.associationsService.assertPaymentsReady(input.associationId!.trim());
  }

  /**
   * Refuses an anonymous form that also takes money or grants something. A payment names its payer
   * to the processor and to the submission, and a cotisation is granted TO an account, so each is
   * the identity the form promised not to keep - refused where it is chosen, not dropped silently.
   */
  private assertAnonymousConfigValid(input: CreateFormDto & { anonymous?: boolean }): void {
    if (input.anonymous !== true) return;
    if (takesMoneyOrGrants(input)) {
      throw new BadRequestException(
        'An anonymous form must be free: a payment or a cotisation grant identifies the submitter.'
      );
    }
    // A file is uploaded by an account and kept on a row that names it, and its CONTENT (a CV)
    // names its author too - the identity the form promised not to keep.
    if (hasFileQuestion(input.items)) {
      throw new BadRequestException(
        'An anonymous form cannot ask for a file: a file is tied to the account that uploads it.'
      );
    }
  }

  /**
   * Refuses a form that asks for a file AND restricts who may submit by an ANSWER. The file is
   * uploaded before the answer exists, and the upload is judged on the same `submitCondition`
   * (`assertMayUploadAnswerFile`) - with no answers yet, an `answer` criterion matches nobody, so
   * every upload would be a 403. Refused where it is chosen rather than shipped as a form nobody can
   * fill. A profile criterion (promo, formation, cotisation) is known at upload and stays allowed.
   */
  private assertFileQuestionConfigValid(input: {
    items?: CreateFormDto['items'];
    submitCondition?: unknown;
  }): void {
    if (!hasFileQuestion(input.items)) return;
    const condition = input.submitCondition as { answer?: unknown } | null | undefined;
    if (condition?.answer != null) {
      throw new BadRequestException(
        'A form that asks for a file cannot restrict who may answer by an answer: the file is sent before the answers exist.'
      );
    }
  }

  /**
   * Refuses a public form that would need to know who a guest is. A guest has no account, so there
   * is nobody to grant a cotisation to, to match a profile criterion against, or to count once -
   * each is refused where it is chosen, rather than being a setting that quietly does nothing for
   * the people the link reaches.
   *
   * A guest CAN pay (decision PP1, `public-paid-forms-chantier.md`): a base price, option
   * supplements, cash, and a price grid whose every criterion is an ANSWER (a menu, a formula).
   * Lydia needs only the e-mail the guest types. A grid criterion on promo, formation or cotisation
   * is WHO the person is, which a guest has not got, so it stays refused.
   */
  private assertPublicConfigValid(input: CreateFormDto): void {
    if (input.isPublic !== true) return;
    if (input.grantsCotisation === true) {
      throw new BadRequestException(
        'A public form cannot grant a cotisation: a guest has no account to grant it to.'
      );
    }
    const dimensions = (input.priceMatrix as PriceMatrix | null | undefined)?.dimensions ?? [];
    if (dimensions.some((d) => d.kind !== 'answer')) {
      throw new BadRequestException(
        'A public form can price only on answers: a guest has no profile to match a promo, a ' +
          'formation or a cotisation against.'
      );
    }
    // A charging grid whose "everyone else" cell is FREE and reachable - a priced question left
    // empty, hidden, or answered with an ungrouped option - would hand a guest a free seat by
    // default, with none of the paid path's limits. The manager prices it or marks it unavailable.
    const freeCells = freeFallbackCells(
      input.priceMatrix as PriceMatrix | null | undefined,
      (input.items ?? []) as PricedItem[]
    );
    if (freeCells.length > 0) {
      throw new BadRequestException(
        'A public form that charges cannot leave its "everyone else" price at 0: a guest who skips ' +
          `or hides a priced question would answer for free (cell "${freeCells[0]}"). Price it or ` +
          'mark it unavailable.'
      );
    }
    // A guest's cash answer holds its seat - and its place under the visitor's ceiling of waiting
    // answers (WP-P3) - until it is validated or its deadline passes. With no deadline it would
    // hold both for ever, and three of them from one shared network would shut that network out.
    // A free form never reaches cash (`submit` offers it only on a total above 0), so a cash flag
    // left over from when it charged - the editor stops sending it once payment is off - is not read.
    if (
      input.allowCashPayment === true &&
      input.cashPaymentExpiryDays == null &&
      chargesMoney(input)
    ) {
      throw new BadRequestException(
        'A public form that accepts cash needs a cash deadline: an unpaid cash answer holds its ' +
          'seat until then.'
      );
    }
    if (input.submitCondition != null || (input.items ?? []).some(hasProfileCriterion)) {
      throw new BadRequestException(
        'A public form cannot depend on who answers: a guest has no profile to match a criterion ' +
          'against.'
      );
    }
    if (input.allowMultipleSubmissions !== true) {
      throw new BadRequestException(
        'A public form must accept several answers: a guest cannot be recognised a second time.'
      );
    }
    // Decision D40: a file upload needs an account, and an anonymous write of files is the largest
    // abuse surface a form could open. Refused here rather than at the guest's submit.
    if (hasFileQuestion(input.items)) {
      throw new BadRequestException(
        'A public form cannot ask for a file: a guest has no account to upload it with.'
      );
    }
  }

  /**
   * Rejects a cotisation configuration the grant path could never honour. Every branch here is a
   * setting that would look saved in the admin screen and then quietly do nothing, so each one is
   * refused at the moment it is chosen rather than discovered by a member who is not one.
   *
   * A tier is validated against the association's own membership products, exactly as
   * `grantCotisant` does - including the base-tier trap, where an association that dropped its
   * un-suffixed product has no base tag for `null` to mean.
   */
  private async assertCotisationConfigValid(
    input: CreateFormDto,
    caller: { userId: string; isGlobalAdmin: boolean }
  ): Promise<void> {
    const wantsGrant = input.grantsCotisation === true;
    const assocId = input.associationId?.trim();

    const itemConditions = (input.items ?? []).filter((item: any) => item.showIf != null);
    const hasCriteria =
      input.priceMatrix != null || input.submitCondition != null || itemConditions.length > 0;
    if (!wantsGrant && !hasCriteria) return;

    // Fetched once and handed down, because every cotisation criterion needs it - but only when
    // something asks for one. A plain paid form still pays for no catalogue lookup and still works
    // on an association that has no cotisation at all.
    const tiers = assocId ? await this.userTagService.listCotisationTiers(assocId) : [];
    const ctx = criteriaContextFor(tiers, input.items ?? []);

    // Validated even when nothing is granted: a grid and a submit condition are not cotisation
    // settings, and refusing them only when a cotisation is involved would let an incomplete grid
    // through on every other form.
    const matrix = input.priceMatrix == null ? null : parsePriceMatrix(input.priceMatrix, ctx);
    if (matrix && !assocId && matrix.dimensions.some((d) => d.kind === 'cotisation')) {
      throw new BadRequestException(
        'A price that depends on a cotisation needs a beneficiary association - there is nothing to ' +
          'be a member of otherwise.'
      );
    }
    if (input.submitCondition != null) {
      parseAudienceCondition(input.submitCondition, ctx, 'submitCondition');
    }
    for (const item of itemConditions) {
      parseAudienceCondition((item as any).showIf, ctx, `items[${(item as any).id ?? '?'}].showIf`);
    }

    if (!wantsGrant) return;

    if (!assocId) {
      throw new BadRequestException(
        'A beneficiary association is required to grant a cotisation - there is nothing to be a ' +
          'member of otherwise.'
      );
    }

    // A form that grants a cotisation on payment does exactly what the manual roster add does, so
    // it demands the same right. Creating a form needs only MEMBERSHIP of the association, and
    // without this check any member could mint cotisants of their own association through a form -
    // a side door around MANAGE_MEMBERS. Pricing is not gated: a price grants nothing.
    const mayGrant = await this.associationsService.mayAct(
      caller.userId,
      assocId,
      AssociationPermissionFlag.MANAGE_MEMBERS,
      { isGlobalAdmin: caller.isGlobalAdmin }
    );
    if (!mayGrant) {
      this.logger.warn(
        `[UserTag] refused a cotisation-granting form: user=${caller.userId.slice(0, 8)} lacks ` +
          `MANAGE_MEMBERS on assoc=${assocId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        'Granting a cotisation requires the right to manage this association members.'
      );
    }
    // The grant only ever runs from `markPaid` or the cash validation, and neither is reached by a
    // submission whose total is zero (it is stored `free`). A grant on a form that charges nothing
    // is therefore not a policy we dislike - it is a setting that cannot fire.
    if (input.requiresPayment !== true) {
      throw new BadRequestException(
        'A form must require payment to grant a cotisation: a free submission never reaches the ' +
          'grant.'
      );
    }

    if (tiers.length === 0) {
      throw new BadRequestException(
        'This association has no cotisation: enable it and add at least one tier before a form ' +
          'can grant it.'
      );
    }
    const tier = input.cotisationVariantKey?.trim() || null;
    if (!tiers.some((t) => t.variantKey === tier)) {
      throw new BadRequestException(
        tier
          ? `Unknown cotisation tier "${tier}" for this association.`
          : 'This association has no base tier - a tier must be chosen.'
      );
    }
  }

  /**
   * The facts a form's criteria are evaluated against, fetching only what the form actually asks
   * for. A form with no profile criterion never reaches core-service.
   */
  private async factsFor(
    form: Form,
    userId: string | undefined,
    answers: Record<string, string[]> = {}
  ): Promise<PricingFacts> {
    const conditions: (AudienceCondition | null)[] = [
      form.submitCondition,
      ...(form.items ?? []).map((item: any) => normaliseCondition(item)),
    ];
    const needProfile =
      dimensionsNeedProfile(form.priceMatrix?.dimensions ?? []) || conditions.some(needsProfile);
    return this.pricingFacts.build({
      userId,
      associationId: form.associationId,
      answers,
      needProfile,
    });
  }

  /**
   * The base price this submitter pays, in cents, and the buckets that decided it.
   *
   * The single answer behind both the quote shown before submitting and the amount actually
   * charged. It was two byte-identical copies when it was one boolean; a grid makes a second copy
   * unthinkable.
   */
  private priceFor(
    form: Form,
    facts: PricingFacts
  ): { baseCents: CellValue; appliedBuckets: { dimensionId: string; label: string }[] } {
    if (!form.priceMatrix) return { baseCents: form.basePrice, appliedBuckets: [] };
    const baseCents = resolveCellPrice(form.priceMatrix, facts);
    const appliedBuckets = form.priceMatrix.dimensions.map((d) => {
      const bucketId = bucketFor(d, facts);
      const bucket = d.buckets.find((b) => b.id === bucketId);
      return { dimensionId: d.id, label: bucket?.label ?? 'Autres' };
    });
    return { baseCents, appliedBuckets };
  }

  /** Refuses a submitter the form is not open to. Enforced here, not only by hiding the form. */
  private assertMaySubmit(form: Form, facts: PricingFacts): void {
    if (!form.submitCondition) return;
    if (matchesCondition(form.submitCondition, facts)) return;
    this.logger.debug(`[FORMS] submit refused by audience condition form=${form.id.slice(0, 8)}`);
    throw new ForbiddenException('This form is not open to you.');
  }

  /**
   * Refuses an upload for a FILE question to a member the form is not open to - the same audience
   * rule `submit` applies, judged BEFORE the bytes are stored, so a member who may not answer cannot
   * park files on the form either. Visibility of the question itself (`showIf`) is not judged here:
   * it may depend on answers not given yet, and `submit` re-reads the whole answer anyway.
   */
  async assertMayUploadAnswerFile(formId: string, userId: string): Promise<void> {
    const form = await this.formRepo.findOne({ where: { id: formId, deletedAt: IsNull() } });
    if (!form) throw new NotFoundException('Form not found');
    if (!form.submitCondition) return;
    this.assertMaySubmit(form, await this.factsFor(form, userId));
  }

  /** Creates a form and assigns stable IDs to all items and options that lack them. */
  async create(input: CreateFormDto, isGlobalAdmin = false) {
    if (input.associationId && !isGlobalAdmin) {
      const member = await this.associationsService.isMember(input.ownerId!, input.associationId);
      if (!member) {
        throw new ForbiddenException('You are not a member of this association.');
      }
    }
    assertUniqueItemIds(input.items);
    this.assertAnonymousConfigValid(input);
    this.assertPublicConfigValid(input);
    this.assertFileQuestionConfigValid(input);
    await this.assertPaidFormAssociationReady(input);
    await this.assertCotisationConfigValid(input, {
      userId: input.ownerId!,
      isGlobalAdmin,
    });
    const { opensAt: opensAtRaw, closedAt: closedAtRaw, ...rest } = input;
    const form = this.formRepo.create({
      ...rest,
      currency: 'eur',
      opensAt: opensAtRaw ? new Date(opensAtRaw) : null,
      closedAt: closedAtRaw ? new Date(closedAtRaw) : null,
      items: input.items.map((item: any) => ({
        ...item,
        id: item.id || makeId('item'),
        options: item.options?.map((opt: any) => ({
          ...opt,
          id: opt.id || makeId('opt'),
        })),
      })),
    });
    return this.formRepo.save(form);
  }

  /**
   * Everything the user may manage, newest first: their own forms, and the forms of associations
   * where they hold MANAGE_FORMS.
   *
   * That second group is the point. `assertFormManager` has always accepted MANAGE_FORMS, so those
   * forms were editable and exportable by API while appearing in no list on any screen - reachable
   * only by someone who already knew the URL.
   *
   * Every row that carries an association also carries its NAME, so the list can say which forms
   * are an association's and which are personal. The id is never what a screen shows.
   */
  async list(ownerId?: string) {
    if (!ownerId) {
      return this.withAssociationNames(
        await this.formRepo.find({ where: { deletedAt: IsNull() }, order: { createdAt: 'DESC' } })
      );
    }
    const managedAssociations = await this.associationsService.associationsWhereUserHasFlag(
      ownerId,
      AssociationPermissionFlag.MANAGE_FORMS
    );
    const managedIds = managedAssociations.map((a) => a.id);

    const [owned, viaAssociation] = await Promise.all([
      this.formRepo.find({ where: { ownerId, deletedAt: IsNull() }, order: { createdAt: 'DESC' } }),
      managedIds.length === 0
        ? Promise.resolve([])
        : this.formRepo
            .createQueryBuilder('f')
            .where('"f"."associationId" IN (:...managedIds)', { managedIds })
            .andWhere('"f"."deletedAt" IS NULL')
            .orderBy('"f"."createdAt"', 'DESC')
            .getMany(),
    ]);

    // The two sets overlap - a form you own in an association you administer is in both - so they
    // are merged by id rather than concatenated.
    const byId = new Map<string, Form>();
    for (const form of [...owned, ...viaAssociation]) {
      byId.set(form.id, form);
    }
    const merged = [...byId.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return this.withAssociationNames(merged);
  }

  /** Attaches `associationName` to every form that names an association. */
  private async withAssociationNames(forms: Form[]) {
    const names = await this.associationsService.namesByIds(
      forms.map((f) => f.associationId).filter(Boolean)
    );
    return forms.map((form) => ({
      ...form,
      associationName: form.associationId ? (names.get(form.associationId) ?? null) : null,
    }));
  }

  /**
   * Returns a single form by ID with its current submission count.
   *
   * A form that does not exist (a deleted one included) is a 404, never `null`: Nest serialises a
   * returned `null` as a `200` with an EMPTY body, which the client could only read as a raw
   * "Empty response from server" - a status code is the answer, an empty success is not.
   */
  async get(id: string) {
    const form = await this.formRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!form) {
      this.logger.debug(`get: form ${id} not found`);
      throw new NotFoundException('Form not found');
    }
    const submissionCount = await this.countActiveSubmissions(id);
    return { ...form, submissionCount };
  }

  /**
   * The submissions holding a place on the form: answered, paid, or waiting to be - an online
   * `pending` only while it is younger than the hold (`seatHoldingWhere`).
   */
  private countActiveSubmissions(formId: string): Promise<number> {
    return this.submissionRepo.count({ where: seatHoldingWhere(formId) });
  }

  /**
   * What a guest on a public form's link may read: the questions and when it is open, and nothing
   * about who made it or who answered. A form that is not public is reported as absent, so the
   * public route cannot be used to learn which ids exist.
   */
  async getPublic(id: string) {
    const form = await this.formRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!form?.isPublic) {
      this.logger.debug(`[FORMS] public read refused, not a public form id=${id.slice(0, 8)}`);
      throw new NotFoundException('Form not found');
    }
    const formFull =
      !!form.maxSubmissions && (await this.countActiveSubmissions(id)) >= form.maxSubmissions;
    // The guest's slice of the grid, exactly as a member's is built (`hasSubmission`), from facts
    // that know nobody: a public form's grid prices on answers only (`assertPublicConfigValid`),
    // so the slice is the whole grid. The page totals from it; `submit` recomputes what is charged.
    const pricing = form.priceMatrix
      ? pricingViewFor(form.priceMatrix, await this.factsFor(form, undefined))
      : null;
    // AN ALLOWLIST, like `submission.projection.ts`: a column added to the form later is not served
    // to anybody holding the link until someone adds it here. The price fields are what the page
    // needs to show a total; nothing names the owner, the association or its payment account.
    return {
      id: form.id,
      title: form.title,
      description: form.description,
      imageUrl: form.imageUrl,
      items: form.items,
      opensAt: form.opensAt,
      closedAt: form.closedAt,
      anonymous: form.anonymous,
      formFull,
      basePrice: form.basePrice,
      currency: form.currency,
      allowCashPayment: form.allowCashPayment,
      pricing,
    };
  }

  /**
   * Throws ForbiddenException unless the caller owns the form, or `mayAct` grants them
   * MANAGE_FORMS on the association the form belongs to.
   *
   * There is no third, per-form grant. A form is managed by whoever owns it and by the
   * association's form managers - one axis, set in one place. See `forms.md`.
   * Returns the form so callers can reuse it without a second query.
   */
  async assertFormManager(formId: string, userId: string, isGlobalAdmin: boolean): Promise<Form> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');
    if (isGlobalAdmin || form.ownerId === userId) return form;
    if (
      form.associationId &&
      (await this.associationsService.mayAct(
        userId,
        form.associationId,
        AssociationPermissionFlag.MANAGE_FORMS,
        { isGlobalAdmin }
      ))
    ) {
      return form;
    }
    throw new ForbiddenException('You are not allowed to manage this form');
  }

  /** Updates a form's metadata and items. Gated by `assertFormManager`. */
  async update(formId: string, input: CreateFormDto, userId: string, isGlobalAdmin: boolean) {
    const form = await this.assertFormManager(formId, userId, isGlobalAdmin);

    // THE ASSOCIATION LINK IS FIXED AT CREATION (user decision, 2026-08-23). A form is either
    // personal or an association's, and which one it is decides who owns it: MANAGE_FORMS on the
    // association is a right over the association's forms, so letting a manager cut the link would
    // let them walk off with a form, and re-pointing it would hand someone else's form to a third
    // association. Neither has an answer to "who owns it now", so neither is offered.
    //
    // An attempt is refused rather than ignored: a silently dropped field is a save that reports
    // success and did something else. An ABSENT field is not an attempt - it means "leave it" - so
    // only a value that is present and different is a refusal.
    if (input.associationId !== undefined) {
      const requested = input.associationId.trim() || null;
      if (requested !== (form.associationId ?? null)) {
        throw new BadRequestException(
          'A form stays with the association it was created for. Create a new form to move it.'
        );
      }
    }

    // ANONYMITY IS FIXED AT CREATION for the same reason the association link is: turning it on
    // would promise anonymity to answers already stored with a name, and turning it off would
    // quietly start naming people who were told they were not. A present, different value is
    // refused; an absent one means "leave it".
    if (input.anonymous !== undefined && input.anonymous !== form.anonymous) {
      throw new BadRequestException(
        'A form stays anonymous, or not, as it was created. Create a new form to change it.'
      );
    }
    // The questions the form WILL have: an absent list keeps the stored one, file questions included.
    const items = input.items ?? form.items;
    // Only the questions this edit SENDS are judged, against the stored ones: a duplicate already
    // stored never blocks an edit that leaves the questions' ids as they are.
    if (input.items !== undefined) assertUniqueItemIds(input.items, form.items);
    this.assertAnonymousConfigValid({ ...input, items, anonymous: form.anonymous });
    // Unlike anonymity, a link can be opened or withdrawn at any time: it promises nothing about
    // the answers already stored. An absent value means "leave it", so the stored one is checked -
    // for every field the check reads, or an edit sending only `isPublic: true` would publish a
    // stored cotisation grant or a promo-priced grid nobody re-checked.
    this.assertPublicConfigValid({
      ...input,
      items,
      isPublic: input.isPublic ?? form.isPublic,
      grantsCotisation: input.grantsCotisation ?? form.grantsCotisation,
      priceMatrix: input.priceMatrix !== undefined ? input.priceMatrix : form.priceMatrix,
      submitCondition:
        input.submitCondition !== undefined ? input.submitCondition : form.submitCondition,
      allowMultipleSubmissions: input.allowMultipleSubmissions ?? form.allowMultipleSubmissions,
      allowCashPayment: input.allowCashPayment ?? form.allowCashPayment,
      // `!== undefined`, not `??`: an explicit null CLEARS the deadline when the form is saved, so
      // the check must see the null, not the stored value it is about to replace.
      cashPaymentExpiryDays:
        input.cashPaymentExpiryDays !== undefined
          ? input.cashPaymentExpiryDays
          : (form.cashPaymentExpiryDays ?? undefined),
      requiresPayment: input.requiresPayment ?? form.requiresPayment,
      basePrice: input.basePrice ?? form.basePrice,
    });
    // An absent condition keeps the stored one, which still meets the questions sent now.
    this.assertFileQuestionConfigValid({
      items,
      submitCondition:
        input.submitCondition !== undefined ? input.submitCondition : form.submitCondition,
    });

    await this.assertPaidFormAssociationReady({ ...input, associationId: form.associationId });
    await this.assertCotisationConfigValid(
      { ...input, associationId: form.associationId },
      { userId, isGlobalAdmin }
    );
    const {
      opensAt: opensAtRaw,
      closedAt: closedAtRaw,
      ownerId: _ownerId,
      associationId: _associationId,
      anonymous: _anonymous,
      ...rest
    } = input;
    Object.assign(form, {
      ...rest,
      currency: 'eur',
      opensAt: opensAtRaw ? new Date(opensAtRaw) : null,
      closedAt: closedAtRaw ? new Date(closedAtRaw) : null,
      items: (input.items ?? form.items).map((item: any) => ({
        ...item,
        id: item.id || makeId('item'),
        options: item.options?.map((opt: any) => ({
          ...opt,
          id: opt.id || makeId('opt'),
        })),
      })),
    });
    return this.formRepo.save(form);
  }

  /**
   * Deletes a form: ARCHIVED when it holds submissions (they are the payers' records and
   * `submissions_form_fk` forbids orphaning them), removed outright when it holds none - see
   * `retireForms`. Requires owner, co-owner, global admin, or MANAGE_FORMS flag. Deleting an
   * already archived form is a no-op that still answers ok.
   */
  async delete(formId: string, userId: string, isGlobalAdmin: boolean) {
    const form = await this.assertFormManager(formId, userId, isGlobalAdmin);
    await retireForms(this.formRepo.manager, { formId: form.id });
    return { ok: true };
  }

  /**
   * Throws ForbiddenException unless the caller is the submitter
   * or passes assertFormManager checks on the parent form.
   */
  async assertSubmissionAccess(
    submissionId: string,
    callerId: string,
    isGlobalAdmin: boolean
  ): Promise<void> {
    const sub = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!sub) throw new NotFoundException('Submission not found');
    if (sub.userId === callerId) return;
    await this.assertFormManager(sub.formId, callerId, isGlobalAdmin);
  }

  /** Returns the most recent completed (paid or free) submission for a given user on a form. */
  async getSubmission(formId: string, userId: string) {
    const submission = await this.submissionRepo.findOne({
      where: [
        { formId, userId, paymentStatus: 'paid' },
        { formId, userId, paymentStatus: 'free' },
      ],
      order: { createdAt: 'DESC' },
    });
    return submission ? toSubmitterView(submission) : null;
  }

  /**
   * Grants the form's configured cotisation tier to a submitter whose payment just landed.
   * Shared by the online-payment confirmation path (`markPaid`) and the cash validation path, which had a copy
   * each.
   *
   * Best-effort by design: the payment is a fact by the time this runs, so a failure here must not
   * unwind it - but it is logged as an error, because a paid cotisation that granted nothing is a
   * user who will be told they are not a member. Answers `failed` ONLY when a retry could succeed
   * (the grant threw), which is what `fulfilPayment` releases its claim on; `not-granted` when the
   * tier was refused as not a rise over the one held (`grantCotisantIfARise`) - final, not retried.
   */
  private async grantCotisationIfConfigured(
    form: Pick<Form, 'grantsCotisation' | 'cotisationVariantKey' | 'associationId'>,
    userId: string,
    grantedBy: string,
    metadata: Record<string, unknown>
  ): Promise<'granted' | 'not-granted' | 'failed'> {
    if (!form.grantsCotisation) return 'granted';
    if (!form.associationId) {
      this.logger.error(
        '[UserTag] Form grants a cotisation but names no beneficiary association - nothing to be ' +
          'a member of. The create/update DTO must reject this pairing.'
      );
      return 'granted';
    }
    try {
      // Ranked like a boutique settlement: a paid form never swaps out a dearer tier by the XOR.
      const outcome = await this.userTagService.grantCotisantIfARise(
        form.associationId,
        userId,
        grantedBy,
        form.cotisationVariantKey,
        metadata
      );
      return 'granted' in outcome ? 'granted' : 'not-granted';
    } catch (e) {
      this.logger.error(
        `[UserTag] Failed to grant cotisation tier "${form.cotisationVariantKey ?? 'base'}" of ` +
          `assoc=${form.associationId.slice(0, 8)} to user=${userId.slice(0, 8)}`,
        e
      );
      return 'failed';
    }
  }

  /**
   * Runs what a landed payment buys - the cotisation (only when a seat was given) and the purchase
   * record - each AT MOST ONCE, decided by a durable flag on the row (migration 084). A payment that
   * landed `paid_over_capacity` also tells the form's managers, once, on the same rule (migration
   * 102, `FormOrganiserAlertService`), while that alert is switched on.
   *
   * Both effects run after the payment's own transaction committed, so a crash between the two, or
   * a failed grant, used to be lost for good, and a replay used to run both again. Now each effect
   * is CLAIMED first (`claimFulfilment`, a conditional UPDATE only one caller can win) and released
   * if it failed, so the next replay of the same payment retries exactly what is missing. No clock.
   */
  private async fulfilPayment(
    submission: Pick<Submission, 'id' | 'formId' | 'userId' | 'totalPaid' | 'paymentStatus'>,
    seatGiven: boolean,
    how: {
      grantedBy: string;
      paymentMethod: 'online' | 'cash';
      metadata: Record<string, unknown>;
    }
  ): Promise<void> {
    const form = await this.formRepo.findOne({
      where: { id: submission.formId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        grantsCotisation: true,
        cotisationVariantKey: true,
        associationId: true,
      },
    });
    if (!form) {
      this.logger.error(
        `[Forms] fulfilment of submission ${submission.id}: form ${submission.formId} not found - ` +
          'nothing granted, nothing recorded'
      );
      return;
    }
    // A guest's payment (a public form, `userId` null) has nobody to grant a cotisation to. A public
    // form cannot be saved with a grant (`assertPublicConfigValid`), so a granting form holding a
    // guest row was made private after the guest answered: the money is real, the grant cannot be.
    // ERROR, once: the flag is claimed and kept, so a replay of the payment does not say it again.
    // A tier refused as not a rise is a payment taken for nothing granted: its purchase record says
    // so (`paid_not_granted`), the durable marker the association's purchases and the hourly report
    // read.
    let tierNotGranted = false;
    if (seatGiven && (await this.claimFulfilment(submission.id, 'cotisationGrantedAt'))) {
      if (!submission.userId) {
        if (form.grantsCotisation) {
          this.logger.error(
            `[Forms] submission ${submission.id} was paid by a guest on form ${form.id}, which ` +
              'grants a cotisation: there is no account to grant it to - nothing granted'
          );
        }
      } else {
        const granted = await this.grantCotisationIfConfigured(
          form,
          submission.userId,
          how.grantedBy,
          how.metadata
        );
        if (granted === 'failed')
          await this.releaseFulfilment(submission.id, 'cotisationGrantedAt');
        tierNotGranted = granted === 'not-granted';
      }
    }
    if (
      form.associationId &&
      submission.totalPaid > 0 &&
      (await this.claimFulfilment(submission.id, 'purchaseRecordedAt'))
    ) {
      try {
        await this.purchaseRecordService.create({
          userId: submission.userId,
          source: 'form',
          formId: submission.formId,
          amountCents: submission.totalPaid,
          paymentMethod: how.paymentMethod,
          status: tierNotGranted ? 'paid_not_granted' : 'paid',
          associationId: form.associationId,
          productName: form.title ?? 'Formulaire',
        });
      } catch (e) {
        this.logger.error(
          `[PurchaseRecord] Failed to record ${how.paymentMethod} purchase for submission ` +
            `${submission.id} - released for the next replay`,
          e
        );
        await this.releaseFulfilment(submission.id, 'purchaseRecordedAt');
      }
    }
    if (submission.paymentStatus === 'paid_over_capacity') {
      await this.alertOrganisersOnce(submission.id, form);
    }
  }

  /**
   * Tells the form's managers, AT MOST ONCE, that this payment landed on a full form: the flag is
   * claimed before the notice is written and released if writing it failed, so the next replay of
   * the same payment retries it. Nothing is claimed while the alert is switched off
   * (`FORM_ORGANISER_ALERT_ENABLED`), so a row settled then is not marked as told.
   */
  private async alertOrganisersOnce(
    submissionId: string,
    form: Pick<Form, 'id' | 'title' | 'ownerId' | 'associationId'>
  ): Promise<void> {
    if (!this.organiserAlert.enabled()) {
      this.logger.debug(
        `[Forms] submission ${submissionId} over capacity: organiser alert switched off - not told`
      );
      return;
    }
    if (!(await this.claimFulfilment(submissionId, 'organiserNotifiedAt'))) return;
    try {
      await this.organiserAlert.tell(form);
    } catch (e) {
      this.logger.error(
        `[Forms] organiser alert for submission ${submissionId} (form ${form.id}) not written - ` +
          'released for the next replay',
        e
      );
      await this.releaseFulfilment(submissionId, 'organiserNotifiedAt');
    }
  }

  /** Takes a fulfilment flag if nobody has: true for exactly one caller, ever (until released). */
  private async claimFulfilment(submissionId: string, flag: FulfilmentFlag): Promise<boolean> {
    const result = await this.submissionRepo
      .createQueryBuilder()
      .update()
      .set({ [flag]: () => 'now()' })
      .where('id = :id', { id: submissionId })
      .andWhere(`"${flag}" IS NULL`)
      .execute();
    const won = (result.affected ?? 0) === 1;
    if (!won) this.logger.debug(`[Forms] ${flag} already set on submission ${submissionId}`);
    return won;
  }

  /** Gives a claimed flag back after its effect failed, so a replay retries it. */
  private async releaseFulfilment(submissionId: string, flag: FulfilmentFlag): Promise<void> {
    await this.submissionRepo.update(submissionId, { [flag]: null });
  }

  /**
   * Per-user submission state, capacity, and everything the fill page needs to show a price.
   *
   * The pricing half used to be one boolean, `memberPricing`. It is now the submitter's own SLICE of
   * the grid: the profile criteria resolved here, the answer criteria and their prices handed over
   * so the page can total live. The page still derives no rule of its own - it renders what this
   * says, which is why swapping the rule underneath it has twice needed no client change.
   */
  async hasSubmission(
    formId: string,
    userId: string
  ): Promise<{
    hasSubmitted: boolean;
    paymentStatus?: string;
    /** The id of the caller's own seat-holding row, when there is one. */
    submissionId?: string;
    formFull: boolean;
    pricing: PricingView | null;
    /** Questions this submitter cannot see because of a PROFILE criterion, answers aside. */
    hiddenItemIds: string[];
    maySubmit: boolean;
  }> {
    const form = await this.formRepo.findOne({ where: { id: formId, deletedAt: IsNull() } });
    if (!form)
      return {
        hasSubmitted: false,
        formFull: false,
        pricing: null,
        hiddenItemIds: [],
        maySubmit: false,
      };

    // Check global capacity independently of per-user state
    let formFull = false;
    if (form.maxSubmissions) {
      formFull = (await this.countActiveSubmissions(formId)) >= form.maxSubmissions;
    }

    const facts = await this.factsFor(form, userId);
    const pricing = form.priceMatrix ? pricingViewFor(form.priceMatrix, facts) : null;
    // A profile row where EVERY combination is unavailable is a form this person cannot answer
    // whatever they click, which is the same outcome as an audience condition refusing them - so it
    // is reported the same way rather than shown as a form with no price.
    const noCombinationAvailable =
      !!pricing && Object.values(pricing.cells).every((cell) => cell === null);
    const maySubmit =
      (!form.submitCondition || matchesCondition(form.submitCondition, facts)) &&
      !noCombinationAvailable;
    // Only the PROFILE half is resolved here. An answer condition stays for the page to evaluate as
    // the person types, which it already did for `dependsOn` - so no predicate is duplicated there.
    const hiddenItemIds = profileHiddenItemIds((form.items ?? []) as ConditionalItem[], facts);

    if (form.allowMultipleSubmissions)
      return { hasSubmitted: false, formFull, pricing, hiddenItemIds, maySubmit };

    // An anonymous form's answers know no author, so "has this account answered" is read from the
    // registry that knows no answer. The status is always `free`: an anonymous form takes no money.
    if (form.anonymous) {
      const answered = await this.respondentRepo.count({ where: { formId, userId } });
      return {
        hasSubmitted: answered > 0,
        paymentStatus: answered > 0 ? 'free' : undefined,
        formFull,
        pricing,
        hiddenItemIds,
        maySubmit,
      };
    }

    // The same predicate as `submit`'s one-answer guard (`answerHoldingWhere`): what the page calls
    // "answered" is exactly what the server refuses a second answer for - `paid_over_capacity`
    // included, which used to show an active pay button the server then answered 409. A checkout
    // abandoned past the hold is no longer an answer, so the person may answer again.
    // EVERY such row is read, as the guard reads them, and the one shown is the most decided
    // (`pickShownAnswer`): a legacy older `paid` behind a newer live `pending` showed "pending",
    // and the page offered a retry the server then refused with ALREADY_ANSWERED.
    const submission = pickShownAnswer(
      await this.submissionRepo.find({
        where: answerHoldingWhere(formId, { userId }),
        order: { createdAt: 'DESC' },
      })
    );
    return {
      hasSubmitted: !!submission,
      paymentStatus: submission?.paymentStatus,
      // The caller's OWN row: a `pending` one is what the page asks `confirm-payment` about, so a
      // payment the payer declined on Lydia's page (no callback, no way back) releases it there.
      submissionId: submission?.id,
      formFull,
      pricing,
      hiddenItemIds,
      maySubmit,
    };
  }

  /**
   * Validates answers, calculates the total price (base + option modifiers), enforces capacity
   * limits, creates a Submission, and - if totalCents > 0 - returns a checkout URL.
   *
   * `visitorAddress` (a guest only, `clientAddress`): who a guest's PAID answer is counted against
   * in the per-visitor ceiling (PP5). Required for a guest who pays; ignored otherwise.
   */
  async submit(
    id: string,
    input: SubmitFormDto,
    origin: SubmitOrigin = 'member',
    visitorAddress?: string
  ) {
    const guest = origin === 'guest';
    // A guest names nobody, whatever reached this call: the row and the payment are written with
    // no account and no stored address, by construction rather than by each caller's care.
    if (guest) input = { ...input, userId: undefined, email: undefined };
    const form = await this.formRepo.findOne({ where: { id, deletedAt: IsNull() } });
    // A guest reaching a form that is not public is told it does not exist, as `getPublic` does.
    if (!form || (guest && !form.isPublic)) throw new NotFoundException('Form not found');

    if (form.opensAt && new Date(form.opensAt) > new Date()) {
      throw new BadRequestException('The form is not open yet.');
    }

    if (form.closedAt && new Date(form.closedAt) < new Date()) {
      throw new BadRequestException('The form is closed.');
    }

    // Validate answer sizes to prevent oversized payloads.
    for (const [key, value] of Object.entries(input.answers ?? {})) {
      if (typeof value === 'string' && (value as string).length > 2000) {
        throw new BadRequestException(`Answer for field ${key} exceeds 2000 characters`);
      }
      if (Array.isArray(value) && (value as unknown[]).length > 50) {
        throw new BadRequestException(`Answer for field ${key} has too many selections (max 50)`);
      }
    }

    // The files this answer cites: their SHAPE here, their ownership inside the transaction below
    // (`FormFilesService.attach`), where it is checked and taken in one write. A form that cannot
    // hold a file question (public, anonymous) never reaches `attach`: refused before anything.
    const fileAnswers = fileAnswersOf(form.items ?? [], input.answers);
    if (fileAnswers.length > 0 && (guest || form.anonymous || !input.userId)) {
      this.logger.warn(
        `[FORMS] submit refused: a file answer on form=${form.id.slice(0, 8)} without an account`
      );
      throw new BadRequestException('This form cannot receive a file without an account.');
    }

    // Answers keyed by the form's own question ids and nothing else (`answerSelections`); the size
    // checks above run over `input.answers` untouched, and so does the per-item loop below.
    const selections = answerSelections(form.items ?? [], input.answers ?? {});

    const facts = await this.factsFor(form, input.userId, selections);
    this.assertMaySubmit(form, facts);

    // What this submitter could actually see. Computed here for the first time: `dependsOn` had only
    // ever been evaluated in the browser, so a hidden question's answer was charged if a client sent
    // one, and - worse - `required` below was enforced on hidden questions, which made any required
    // conditional question unsubmittable for everyone the condition did not select.
    const visible = visibleItemIds(form.items ?? [], facts);
    const visibleAnswers: Record<string, string[]> = {};
    for (const [questionId, value] of Object.entries(selections)) {
      if (visible.has(questionId)) visibleAnswers[questionId] = value;
    }
    // An answer that decides a price names the question's own options and nothing else: an unknown
    // id would select no group and no supplement - the "everyone else" price - while reading as the
    // choice it names. Member and guest alike (`answer-options.ts`).
    assertDeclaredOptionAnswers(form.items ?? [], input.answers ?? {}, visible, form.priceMatrix);
    // What is STORED is what was priced: the answer to a question this submitter did not see was
    // neither charged nor required, so it is not kept either - it would read as a choice nobody
    // paid for. A question the form does not declare is kept as it always was.
    const declaredIds = new Set((form.items ?? []).map((item) => item.id));
    const storedAnswers = Object.fromEntries(
      Object.entries(input.answers ?? {}).filter(
        ([key]) => !declaredIds.has(key) || visible.has(key)
      )
    );
    const storedFileAnswers = fileAnswers.filter((file) => visible.has(file.itemId));
    const pricedQuestions = pricedQuestionIds(form.priceMatrix);
    const { baseCents } = this.priceFor(form, { ...facts, answers: visibleAnswers });
    // The cell the manager marked as not existing. A refusal, not a price of zero - and refused
    // here rather than in `assertMaySubmit` because only the visible answers decide the cell.
    if (baseCents === null) {
      this.logger.debug(
        `[FORMS] submit refused by an unavailable grid cell form=${form.id.slice(0, 8)}`
      );
      throw new ForbiddenException('This combination is not available on this form.');
    }

    // Validation & Price Calculation
    let totalCents = baseCents;
    const lineItems: any[] = [];
    const currency = form.currency.toLowerCase();

    if (baseCents > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: `${form.title} (Registration)` },
          unit_amount: baseCents,
        },
        quantity: 1,
      });
    }

    for (const item of form.items) {
      // A question this submitter never saw neither charges them nor blocks them.
      if (!visible.has(item.id)) continue;
      const answer = input.answers[item.id];
      if (item.required && !this.hasValue(answer)) {
        throw new BadRequestException(`Missing required field: ${item.label}`);
      }

      // A question the grid prices on has already been paid for by the cell it selected. Adding its
      // modifier on top would charge the same choice twice, silently, in the direction that
      // overcharges - so it is skipped here rather than trusted to be zero in the document.
      if (answer && item.options?.length && !pricedQuestions.has(item.id)) {
        totalCents = this.calculateModifiers(item, answer, totalCents, lineItems, currency);
      }
    }

    // C1+C2: the capacity check and the submission upsert are ONE transaction, serialised on the
    // form's row lock, so two concurrent requests cannot both pass the capacity check (C2) nor both
    // create a pending submission for the same user (C1 double-charge). It used to be REPEATABLE
    // READ with no lock, which prevents neither: two snapshots each count the seat as free and
    // each insert, a write skew that isolation level does not detect. READ COMMITTED is required
    // by the lock (`lockFormSeats`), and late payments (`markPaid`) queue on the same lock.
    // Reuse an existing pending submission to avoid double-charge, unless multiple submissions are
    // allowed (e.g. order forms where each submit is a new purchase). Only one still holding its
    // seat: a row past the hold is not counted below, so reviving it would take a seat the count
    // never saw, and it stays for the expiry job (and a late payment).
    const reuses = !form.anonymous && !guest && totalCents > 0 && !form.allowMultipleSubmissions;
    const liveRow = () =>
      ({
        where: livePendingWhere(id, { userId: input.userId }),
        order: { createdAt: 'DESC' },
      }) as const;

    // D2: the request a live row is waiting on is SETTLED at the provider before anything else is
    // issued for that row - cancelled, or found paid (then the person has paid and the retry stops
    // here). The row keeps naming that request until this is known: it is cleared in the
    // transaction below, after the answer, never before. A request that cannot be settled refuses
    // the retry (`PREVIOUS_PAYMENT_OPEN`) rather than leave two payable requests for one answer.
    const previous = reuses ? await this.submissionRepo.findOne(liveRow()) : null;
    // ONE ANSWER PER PERSON, checked FIRST, before any side effect: an answer that already counts
    // refuses here, before the settle below cancels anything at Lydia. Repeated under the lock.
    const oneAnswer = !form.anonymous && !guest && !form.allowMultipleSubmissions && !!input.userId;
    if (oneAnswer) {
      await this.assertNoOtherAnswer(this.submissionRepo.manager, id, input.userId!, previous?.id);
    }
    if (previous) {
      const settled = await this.settleOpenRequest(previous, form);
      if (settled === 'paid') return { submissionId: previous.id, alreadyPaid: true };
    }

    // A guest who pays ONLINE leaves for Lydia and comes back with no session: the receipt, minted
    // here and stored hashed on the row, is what its return page shows instead (`guest-receipt.ts`).
    // Cash needs none - the guest reads the reference at once, on the page that sent the answer.
    const receipt =
      guest && totalCents > 0 && !(form.allowCashPayment && input.paymentMethod === 'cash')
        ? newGuestReceipt()
        : null;
    // A guest's PAID answer waits for its money while holding a seat, online or in cash: it names
    // who is waiting, so one visitor cannot hold more than the ceiling (PP5, `guest-visitor.ts`).
    let visitorKey: string | null = null;
    if (guest && totalCents > 0) {
      if (!visitorAddress) {
        throw new Error(`guest paid answer on form ${id} reached submit without a visitor address`);
      }
      visitorKey = guestVisitorKey(id, visitorAddress);
    }

    let savedSubmission!: Submission;
    await this.submissionRepo.manager.transaction('READ COMMITTED', async (manager) => {
      await lockFormSeats(manager, id);

      // Looked up BEFORE the capacity check: the row already holds this person's seat, so a retry
      // on a form it filled is a retry, not a new answer - it used to be refused as "Form is full".
      let existingPending: Submission | null = null;
      if (previous) {
        // The row whose request was settled above, re-read under its lock. It must still name that
        // request (anything else is a concurrent submit issuing its own). It may have LEFT
        // `pending` meanwhile: Lydia calls `cancel_url` for the request this retry cancelled, and
        // that report names the row's request, so it cancels the row - a cancel this retry caused
        // and now takes back. A row that left `pending` holds no seat, so the capacity check runs.
        existingPending = await manager.findOne(Submission, {
          where: { id: previous.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !existingPending ||
          !['pending', 'cancelled', 'expired'].includes(existingPending.paymentStatus) ||
          existingPending.paymentRequestId !== previous.paymentRequestId ||
          existingPending.stripeSessionId !== previous.stripeSessionId
        ) {
          throw this.previousPaymentOpen(
            previous.id,
            'the row changed while its request was being settled'
          );
        }
      } else if (reuses) {
        const concurrent = await manager.findOne(Submission, {
          ...liveRow(),
          lock: { mode: 'pessimistic_write' },
        });
        if (concurrent) {
          throw this.previousPaymentOpen(
            concurrent.id,
            'a concurrent submit is issuing its request'
          );
        }
      }
      // The AUTHORITATIVE one-answer check, under the form lock (the one before the settle above
      // only spares a provider call): the row this retry reuses is excluded by id.
      if (oneAnswer)
        await this.assertNoOtherAnswer(manager, id, input.userId!, existingPending?.id);

      const holdsSeat =
        !!existingPending &&
        (await manager.count(Submission, {
          where: livePendingWhere(id, { id: existingPending.id }),
        })) > 0;

      if (form.maxSubmissions && !holdsSeat) {
        const count = await manager.count(Submission, { where: seatHoldingWhere(id) });
        if (count >= form.maxSubmissions) throw new BadRequestException('Form is full');
      }
      // PP5, under the form lock like the capacity count: two submits from one visitor queue here,
      // so the fourth sees the three before it. Counted from the rows that still WAIT - an online
      // answer within its hold, a cash one not yet validated - so a paid, cancelled or expired one
      // frees its place in the ceiling with no job having run.
      if (visitorKey) {
        const waiting = await manager.count(Submission, {
          where: [
            livePendingWhere(id, { guestVisitorKey: visitorKey }),
            { formId: id, guestVisitorKey: visitorKey, paymentStatus: 'pending_cash' },
          ],
        });
        if (waiting >= GUEST_PENDING_CEILING) {
          this.logger.warn(
            `[Forms] guest answer refused on form ${id.slice(0, 8)}: this visitor already has ` +
              `${waiting} answers waiting for payment (ceiling ${GUEST_PENDING_CEILING})`
          );
          throw new HttpException(
            {
              code: GUEST_PENDING_LIMIT,
              message: `This visitor already has ${GUEST_PENDING_CEILING} answers waiting for payment on this form. Pay or let one expire first.`,
            },
            HttpStatus.TOO_MANY_REQUESTS
          );
        }
      }

      // A guest's FREE answer, and every anonymous answer. A guest who owes money takes the paid
      // path below with no account (`userId` null), like a member's: the payer is the e-mail they
      // typed for Lydia, never stored (decision PP2).
      if (form.anonymous || (guest && totalCents === 0)) {
        if (!guest && !input.userId) throw new BadRequestException('Sign in to answer this form.');
        // An option supplement could still charge on an anonymous form saved free; a charge would
        // need the payer, which is the one thing an anonymous answer promised not to keep.
        if (totalCents > 0) {
          throw new BadRequestException('An anonymous form cannot charge for an option.');
        }
        // The registry insert and the answer are ONE transaction, and the answer carries nothing
        // that names the respondent: no account, no address, and a time cut to the day, because a
        // precise clock would re-join the two tables by order alone. A guest is never in the
        // registry: a public form takes several answers, and there is no account to write.
        if (!guest && !form.allowMultipleSubmissions) {
          const inserted: unknown[] = await manager.query(
            `INSERT INTO form_respondents ("formId", "userId") VALUES ($1, $2)
             ON CONFLICT DO NOTHING RETURNING "formId"`,
            [id, input.userId]
          );
          if (inserted.length === 0) {
            throw new BadRequestException('You have already answered this form.');
          }
        }
        // A guest on a form that is NOT anonymous keeps its real time: the manager was promised no
        // forgetting, and the answer carries no account for a clock to re-join.
        const day = new Date();
        day.setUTCHours(0, 0, 0, 0);
        savedSubmission = await manager.save(
          manager.create(Submission, {
            formId: id,
            userId: null,
            email: undefined,
            answers: storedAnswers,
            totalPaid: 0,
            paymentStatus: 'free',
            paymentMethod: null,
            cashExpiresAt: null,
            ...(form.anonymous ? { createdAt: day, updatedAt: day } : {}),
          })
        );
        return;
      }

      if (existingPending) {
        existingPending.answers = storedAnswers;
        existingPending.totalPaid = totalCents;
        existingPending.email = input.email;
        // Its old request is settled (above), so the row stops naming it: a late report about it
        // changes nothing (`cancelPendingSubmission`). The new request's ids are written once the
        // provider answers; until then the row names NO request, which is what makes a concurrent
        // retry refuse instead of issuing a third one (`settleOpenRequest`).
        existingPending.paymentRequestId = null;
        existingPending.stripeSessionId = null;
        existingPending.paymentStatus = 'pending';
        savedSubmission = await manager.save(existingPending);
        // A new payment request is about to be issued for this row, so its hold restarts with it,
        // on the database clock like every other read of it (`seat-hold.ts`).
        await manager.update(Submission, existingPending.id, {
          paymentRequestedAt: () => 'now()',
        });
        this.logger.debug(
          `[Forms] submit reuses pending submission ${existingPending.id}: its hold restarts`
        );
      } else {
        const submission = manager.create(Submission, {
          formId: id,
          userId: input.userId ?? null,
          email: input.email,
          answers: storedAnswers,
          totalPaid: totalCents,
          paymentStatus: totalCents > 0 ? 'pending' : 'free',
          paymentMethod: null,
          cashExpiresAt: null,
          guestReceiptHash: receipt?.hash ?? null,
          guestVisitorKey: visitorKey,
        });
        savedSubmission = await manager.save(submission);
      }
      if (storedFileAnswers.length > 0) {
        await this.formFiles.attach(manager, savedSubmission, id, input.userId!, storedFileAnswers);
      }
    });

    // Cash payment shortcut - skip the online checkout entirely
    if (totalCents > 0 && form.allowCashPayment && input.paymentMethod === 'cash') {
      const cashExpiresAt =
        form.cashPaymentExpiryDays != null
          ? new Date(Date.now() + form.cashPaymentExpiryDays * 24 * 60 * 60 * 1000)
          : null;
      savedSubmission.paymentStatus = 'pending_cash';
      savedSubmission.paymentMethod = 'cash';
      savedSubmission.cashExpiresAt = cashExpiresAt;
      // Named columns, never a whole-entity save: the entity still carries the
      // `paymentRequestedAt` read before the transaction rewrote it, and would write it back.
      await this.submissionRepo.update(savedSubmission.id, {
        paymentStatus: 'pending_cash',
        paymentMethod: 'cash',
        cashExpiresAt,
      });
      this.logger.log(`[Forms] Cash payment pending for submission ${savedSubmission.id}`);
      return {
        submissionId: savedSubmission.id,
        cashPayment: true,
        ...(guest ? { reference: guestReference(savedSubmission.id) } : {}),
      };
    }

    if (totalCents > 0) {
      // Delegate checkout creation to the central payment service as a single consolidated item
      const singleLineItem: any[] = [
        {
          price_data: {
            currency,
            product_data: { name: `${form.title} (Registration)` },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ];

      const checkoutUrl = coreUrl('payments/create-checkout-session');

      try {
        // If the form belongs to an association, route payment via its connected account
        let connectAccountId: string | undefined;
        if (form.associationId) {
          await this.associationsService.assertPaymentsReady(form.associationId);
          const acctId = await this.associationsService.getPaymentAccountId(form.associationId);
          if (acctId) connectAccountId = acctId;
        }

        // order_ref for Lydia's request/do callback (see webhook.controller.ts).
        const activeProvider = await this.associationsService.getActivePaymentProvider();
        if (activeProvider === 'disabled') {
          this.logger.warn(
            `[Forms] Paid submission ${savedSubmission.id} refused: payments are disabled`
          );
          throw new BadRequestException(PAYMENTS_DISABLED_MESSAGE);
        }
        // The provider's payable range, refused here rather than by core: the SAME typed answer
        // (code + bounds) the payer's page words in their language, one call sooner. AFTER the
        // disabled check, so a form on an estate with payments off says that, not a range. The
        // catch below releases the row and passes this exception through untouched.
        if (totalCents < PROVIDER_MIN_AMOUNT_CENTS || totalCents > PROVIDER_MAX_AMOUNT_CENTS) {
          this.logger.warn(
            `[Forms] Paid submission ${savedSubmission.id} refused: total=${totalCents} cents outside ` +
              `${PROVIDER_MIN_AMOUNT_CENTS}-${PROVIDER_MAX_AMOUNT_CENTS} form=${id.slice(0, 8)}`
          );
          throw amountOutOfRange(
            PROVIDER_MIN_AMOUNT_CENTS,
            PROVIDER_MAX_AMOUNT_CENTS,
            `Total amount (${(totalCents / 100).toFixed(2)} ${currency.toUpperCase()}) is outside the ` +
              `payable range ${(PROVIDER_MIN_AMOUNT_CENTS / 100).toFixed(2)}-` +
              `${(PROVIDER_MAX_AMOUNT_CENTS / 100).toFixed(2)} ${currency.toUpperCase()}. Adjust the form price.`
          );
        }
        const idempotencyKey = `form:${savedSubmission.id}`;

        const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost';
        // A guest is sent back to the public form's RECEIPT page, never to `/forms/success`: that
        // page reads the answer through a session the guest has not got. The URL carries the
        // receipt and nothing that decides anything: the page only asks the server, which asks
        // Lydia. The server chooses it; a guest names no return URL (`GuestSubmitFormDto`).
        // `receipt` is minted for exactly this case (a guest paying online), above the transaction.
        const guestReturn = guest
          ? `${frontendUrl}/f/${encodeURIComponent(id)}/receipt?receipt=${receipt!.token}`
          : null;
        const successUrl = guestReturn
          ? guestReturn
          : resolveCheckoutCallbackUrl(
              input.successUrl,
              `${frontendUrl}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
              frontendUrl
            );
        const cancelUrl = guestReturn
          ? guestReturn
          : resolveCheckoutCallbackUrl(
              input.cancelUrl,
              `${frontendUrl}/forms/cancel?session_id={CHECKOUT_SESSION_ID}`,
              frontendUrl
            );
        const res = await axios.post(
          checkoutUrl,
          {
            lineItems: singleLineItem,
            successUrl: withSubmissionReturnKey(successUrl, savedSubmission.id),
            cancelUrl: withSubmissionReturnKey(cancelUrl, savedSubmission.id),
            metadata: { submissionId: savedSubmission.id, formId: id, userId: input.userId ?? '' },
            connectAccountId,
            idempotencyKey,
            payerEmail: input.payerEmail,
            // The request dies before the seat is released (`seat-hold.ts`).
            expireAfterSeconds: PAYMENT_REQUEST_LIFETIME_SECONDS,
          },
          internalCoreRequestConfig()
        );

        const data = res.data || {};
        const sessionUrl = data.url || data.checkoutUrl || null;
        const sessionId = data.id || data.sessionId || null;
        const requestId: string | null = typeof data.requestId === 'string' ? data.requestId : null;

        if (!sessionUrl) {
          await this.releaseUnissuedRow(savedSubmission.id);
          return {
            message: data.message || 'Payment service did not return a checkout URL',
            submissionId: savedSubmission.id,
          };
        }

        if (sessionId || requestId) {
          savedSubmission.stripeSessionId = sessionId;
          savedSubmission.paymentRequestId = requestId;
          // Named columns: a whole-entity save would write back a stale `paymentRequestedAt`.
          await this.submissionRepo.update(savedSubmission.id, {
            stripeSessionId: sessionId,
            paymentRequestId: requestId,
          });
        }

        return { checkoutUrl: sessionUrl, submissionId: savedSubmission.id };
      } catch (err: unknown) {
        // No request was issued, so nothing is payable: the row stops holding a seat for it.
        await this.releaseUnissuedRow(savedSubmission.id);
        throw mapCorePaymentError(err, this.logger, 'Forms');
      }
    }

    return { submissionId: savedSubmission.id };
  }

  /**
   * Settles, at the provider, the request a live pending row is waiting on, before anything else
   * is issued for that row (a new request on a retry, a switch to cash) or the row is cancelled by
   * its submitter (D2). Answers `free` when the request can no longer be paid, or `paid` when it
   * WAS paid - the row is then marked paid here (`markPaid`, as the callback would) and the caller
   * stops. Throws `PREVIOUS_PAYMENT_OPEN` (409) whenever that cannot be established:
   *
   * - Lydia's cancel answers error 2 (`already-settled`) for a request already processed - measured
   *   on cancelled and expired ones, and very probably the same for a PAID one. So error 2 is never
   *   read as "nobody paid": `request/state` (by the uuid) tells `paid` from `declined` and
   *   `cancelled-or-expired`, both of which free the row; `open` and `unknown` refuse.
   * - A row naming NO request is one whose request is being issued right now (`submit` clears the
   *   ids in its transaction and writes the new ones once the provider answers; a failed issue
   *   releases the row, `releaseUnissuedRow`). Issuing another would leave two payable requests.
   * - A row written before migration 084 names only the uuid: it cannot be cancelled (`request/
   *   cancel` takes the numeric id), so it is settled only if its state is already closed or paid.
   * - Any failure to reach the provider: refusing is the one answer that cannot double-charge.
   */
  private async settleOpenRequest(row: Submission, form: Form): Promise<'free' | 'paid'> {
    const requestId = row.paymentRequestId;
    const sessionId = row.stripeSessionId;
    if (!requestId && !sessionId) {
      throw this.previousPaymentOpen(row.id, 'its request is being issued');
    }
    const connectAccountId = form.associationId
      ? await this.associationsService.getPaymentAccountId(form.associationId)
      : null;
    if (!connectAccountId) {
      throw this.previousPaymentOpen(row.id, 'the form has no payment account to cancel it with');
    }
    try {
      if (requestId) {
        const { data } = await axios.post(
          coreUrl('payments/cancel-request'),
          { requestId, connectAccountId },
          internalCoreRequestConfig()
        );
        if (data?.outcome === 'cancelled') {
          this.logger.log(`[Forms] submission ${row.id}: request ${requestId} cancelled`);
          return 'free';
        }
        if (data?.outcome !== 'already-settled') {
          throw new Error(`unexpected cancel outcome ${JSON.stringify(data?.outcome)}`);
        }
      }
      if (!sessionId) throw new Error('no request_uuid to read the state by');
      const { state, raw } = await this.readRequestState(sessionId, connectAccountId);
      if (SETTLED_REFUSED_REQUEST_STATES.has(state)) {
        // Declined by the payer, or cancelled / expired: nothing is payable, a new request may go.
        this.logger.log(`[Forms] submission ${row.id}: request ${sessionId} already ${state}`);
        return 'free';
      }
      if (state === 'paid') {
        // The person paid the request they are now retrying: the answer is paid, and a second
        // request would charge them twice. Recorded as the callback would record it.
        this.logger.log(
          `[Forms] submission ${row.id}: request ${requestId ?? sessionId} was PAID before the retry - marked paid, no new request issued`
        );
        await this.markPaid(row.id, requestId ?? sessionId);
        return 'paid';
      }
      throw new Error(`request ${sessionId} is ${state} (code ${raw})`);
    } catch (err: unknown) {
      throw this.previousPaymentOpen(row.id, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Reads a request's state through core-service `payments/request-state` (uuid + the Business's
   * vendor token), typed at the boundary (`toRequestState`): the callers decide on the type and
   * never on core's raw code, which is only carried for their log. A failed call throws.
   */
  private async readRequestState(
    sessionId: string,
    connectAccountId: string
  ): Promise<{ state: RequestState; raw: string }> {
    const { data } = await axios.post(
      coreUrl('payments/request-state'),
      { sessionId, connectAccountId },
      internalCoreRequestConfig()
    );
    const state = toRequestState(data?.state);
    const raw = typeof data?.raw === 'string' ? data.raw : '';
    // core already WARNs an unknown provider code; this one is a WIRE mismatch (an older core
    // answering `closed` mid-deploy, a missing field), which nothing else would report.
    if (state === 'unknown' && data?.state !== 'unknown') {
      this.logger.warn(
        `[Forms] request ${sessionId}: core answered a state this service does not know (${JSON.stringify(data?.state ?? null)}, code ${raw}) - treated as neither paid nor settled`
      );
    }
    return { state, raw };
  }

  /**
   * ONE ANSWER PER PERSON on a single-answer form, read from the submissions table (never a client
   * flag). A submit after a PAID answer used to insert a new row and issue a new request/do - a
   * second charge for one answer. EVERY row that counts as an answer (`answerHoldingWhere`) is
   * read, not the newest one: an older paid row hidden behind a newer live pending one must still
   * refuse. `excludeId` is the live pending row a retry reuses, which is not "another answer"; a
   * cancelled or expired row (declined, cancelled or expired request) is no answer at all.
   *
   * Refused at INFO: a second tab, a back button or a double tap past the page's own guard is
   * expected, and nothing has been issued yet. A real double charge is accused by `markPaid`.
   */
  private async assertNoOtherAnswer(
    manager: EntityManager,
    formId: string,
    userId: string,
    excludeId: string | undefined
  ): Promise<void> {
    const answers = await manager.find(Submission, {
      where: answerHoldingWhere(formId, { userId }),
    });
    const other = answers.find((answer) => answer.id !== excludeId);
    if (!other) return;
    this.logger.log(
      `[Forms] submit refused on form ${formId}: submission ${other.id} (${other.paymentStatus}) already answers for this person - no request issued`
    );
    throw new ConflictException({
      code: ALREADY_ANSWERED,
      message: 'You have already answered this form.',
    });
  }

  /** The typed refusal of `settleOpenRequest`, logged at WARN with its reason. */
  private previousPaymentOpen(submissionId: string, reason: string): ConflictException {
    this.logger.warn(
      `[Forms] submission ${submissionId}: previous payment request still open (${reason}) - refused`
    );
    return new ConflictException({
      code: PREVIOUS_PAYMENT_OPEN,
      message:
        'The previous payment request is still open. Try again once it has expired, at most 30 minutes after it was started.',
    });
  }

  /**
   * Cancels a `pending` row whose payment request was never issued (the provider refused, the call
   * failed, payments are off): nothing is payable, so it must not hold a seat for 30 minutes, and a
   * row naming no request would otherwise read as "being issued" to the next retry. A row that DOES
   * name a request is left alone.
   */
  private async releaseUnissuedRow(submissionId: string): Promise<void> {
    const outcome = await this.moveLockedSubmission(submissionId, 'pending', 'cancelled', {
      named: (s) => !s.paymentRequestId && !s.stripeSessionId,
    });
    if (typeof outcome === 'object') {
      this.logger.log(`[Forms] submission ${submissionId} released: no payment request was issued`);
    }
  }

  /** Deletes a submission. Requires form manager access. */
  async deleteSubmission(
    submissionId: string,
    callerId: string,
    isGlobalAdmin: boolean
  ): Promise<void> {
    const sub = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!sub) throw new NotFoundException('Submission not found');
    await this.assertFormManager(sub.formId, callerId, isGlobalAdmin);
    await this.submissionRepo.delete(submissionId);
    this.logger.log(`[Forms] Submission ${submissionId} deleted by ${callerId}`);
  }

  /**
   * Loads a submission by ID with its payment status, for its submitter or a manager. It used to
   * answer `paymentAccountId` too - the Business's Lydia `vendor_token`, which no client read and
   * which lets anyone cancel that Business's payment requests (`submission.projection.ts`).
   */
  async getSubmissionById(submissionId: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    return this.submitterAnswer(submission);
  }

  /** What a submitter is answered about a row already read (`toSubmitterView`, plus the currency). */
  private async submitterAnswer(submission: Submission) {
    const form = await this.formRepo.findOne({ where: { id: submission.formId } });
    const { id, formId, totalPaid, paymentStatus } = toSubmitterView(submission);
    return { id, formId, totalPaid, currency: form?.currency ?? 'eur', paymentStatus };
  }

  /**
   * Records that a submission has been paid, and grants everything that payment buys.
   *
   * THE CALLER IS THE AUTHORISATION, WHICH IS WHY THIS TAKES NO CALLER. No route reaches it: it
   * runs only once Lydia itself, asked server to server about the row's OWN request, answered paid
   * (`settleFromProvider`, from the payer's return or a verified callback; `settleOpenRequest`, from
   * a retry) - so by the time this runs, the payment is a fact established somewhere that cannot be
   * spoofed by a client. It used to accept `callerId`/`isGlobalAdmin` and
   * run `assertSubmissionAccess` only `if (callerId)`: a check that quietly did not happen when the
   * argument was absent, behind a public route the SUBMITTER could reach. Both are gone.
   *
   * A LATE PAYMENT IS DECIDED FROM THE ROW, under the form's seat lock (PP4,
   * `public-paid-forms-chantier.md`). A row still holding its seat becomes `paid`. A row that holds
   * none - `expired`, `cancelled`, or `pending` past the hold before the job reached it - becomes
   * `paid` if the form still has room, else `paid_over_capacity`: the money landed, the seat did
   * not, and the organiser refunds it outside the application. Two late payments queue on the lock,
   * so they cannot both take the last seat.
   *
   * A SECOND CALL ON A SETTLED ROW IS A REPLAY: the status does not move. The Lydia callback and
   * the payer's return (`confirmPayment`, while the row is still `pending`) can both land here for
   * one payment, in either order, and Lydia may repeat a callback. Before 2026-10-15 each call
   * re-granted and wrote ANOTHER purchase record; now the effects run from durable flags
   * (`fulfilPayment`), so a replay only finishes what is missing.
   *
   * THE REQUEST ID NEVER DECIDES THE STATUS, BUT A FOREIGN ONE IS ACCUSED. The two callers carry two
   * DIFFERENT ids for one payment - the callback's numeric `request_id`, `confirmPayment`'s
   * `request_uuid` - and the row stores both (`paymentRequestId`, `stripeSessionId`), so a replay
   * naming neither is a second request paid for one answer: logged at ERROR, status unchanged (the
   * money already landed; refusing would only hide it). The id that settled the row is kept in
   * `paymentSettledBy`.
   *
   * ONE ANSWER PER PERSON: on a single-answer form, a late payment whose payer already has another
   * row holding a seat or paid lands `paid_over_capacity`, logged at ERROR.
   *
   * `onlyIfRowNames` (the payer's return, `confirmPayment`): the request was read paid OUTSIDE
   * this lock, so the row must still name that very uuid once locked. If a retry replaced it in
   * between, the retry's own settle already read that request and decided it - nothing is written.
   */
  async markPaid(submissionId: string, sessionId?: string, onlyIfRowNames = false) {
    const found = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!found) throw new NotFoundException('Submission not found');

    const outcome = await this.submissionRepo.manager.transaction(
      'READ COMMITTED',
      async (manager) => {
        await lockFormSeats(manager, found.formId);
        const submission = await manager.findOne(Submission, {
          where: { id: submissionId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!submission) throw new NotFoundException('Submission not found');
        if (onlyIfRowNames && submission.stripeSessionId !== sessionId) {
          return { submission, status: submission.paymentStatus, replay: true, stale: true };
        }
        if (SETTLED_PAYMENT_STATUSES.has(submission.paymentStatus)) {
          return { submission, status: submission.paymentStatus, replay: true };
        }
        const holdsSeat =
          (await manager.count(Submission, {
            where: seatHoldingWhere(submission.formId, { id: submissionId }),
          })) > 0;
        let status = 'paid';
        if (!holdsSeat) {
          const form = await manager.findOne(Form, {
            where: { id: submission.formId },
            select: { id: true, maxSubmissions: true, allowMultipleSubmissions: true },
          });
          const taken = form?.maxSubmissions
            ? await manager.count(Submission, { where: seatHoldingWhere(submission.formId) })
            : 0;
          if (form?.maxSubmissions && taken >= form.maxSubmissions) status = 'paid_over_capacity';
          // ONE answer per person: a late payment on an old row, when the same person already has
          // another row holding a seat or paid (a new answer written after this one's hold), is a
          // second payment for one answer - never a silent second `paid`.
          const other =
            form && !form.allowMultipleSubmissions && submission.userId
              ? await manager.findOne(Submission, {
                  where: [
                    ...seatHoldingWhere(submission.formId, { userId: submission.userId }),
                    {
                      formId: submission.formId,
                      userId: submission.userId,
                      paymentStatus: 'paid_over_capacity',
                    },
                  ],
                  select: { id: true, paymentStatus: true },
                })
              : null;
          if (other && other.id !== submissionId) {
            status = 'paid_over_capacity';
            this.logger.error(
              `[Forms] Late payment on submission ${submissionId} (form ${submission.formId}, ` +
                `${submission.totalPaid} cents): the same person already has submission ${other.id} ` +
                `(${other.paymentStatus}) on this one-answer form - TWO PAYMENTS for one answer, refund owed`
            );
          }
          this.logger.log(
            `[Forms] Late payment on submission ${submissionId} (was ${submission.paymentStatus}): ` +
              `${taken}/${form?.maxSubmissions ?? 'unlimited'} seats taken -> ${status}`
          );
        }
        submission.paymentStatus = status;
        // The id that settled the row, in its own column: `stripeSessionId` keeps naming the
        // request (`request_uuid`) and is no longer overwritten with whichever id arrived first.
        submission.paymentSettledBy = sessionId ?? null;
        await manager.save(submission);
        return { submission, status, replay: false };
      }
    );
    const { submission } = outcome;

    if ('stale' in outcome) {
      this.logger.warn(
        `[Forms] markPaid on submission ${submissionId}: request ${sessionId} was read paid, but the ` +
          `row now names ${submission.stripeSessionId ?? 'no request'} - a retry replaced it and settled it; nothing written`
      );
      return { ok: false };
    }

    if (outcome.replay) {
      // The row now names its request by BOTH ids (`paymentRequestId`, the numeric one callbacks
      // carry; `stripeSessionId`, the uuid), so a confirmation naming NEITHER is a second request
      // paid for one answer. A row written before migration 084 names only the uuid, so the
      // numeric id of its own callback cannot be told apart and is not accused.
      const known = [submission.paymentRequestId, submission.stripeSessionId];
      if (sessionId && submission.paymentRequestId && !known.includes(sessionId)) {
        this.logger.error(
          `[Forms] markPaid on submission ${submissionId}, already ${outcome.status} by ` +
            `${submission.paymentSettledBy ?? 'unknown'}, names ANOTHER request ${sessionId} ` +
            `(the row's are ${known.join(' / ')}): TWO PAYMENTS for one answer, refund owed`
        );
      } else {
        this.logger.debug(
          `[Forms] markPaid replay on submission ${submissionId}, already ${outcome.status}`
        );
      }
    } else if (outcome.status === 'paid_over_capacity') {
      // The money is the payer's until the organiser refunds it: no cotisation is granted for a
      // seat that was not given. The purchase record below is still written - it is the payer's
      // trace that they paid.
      this.logger.warn(
        `[Forms] Payment on submission ${submissionId} landed OVER CAPACITY ` +
          `(form ${submission.formId}, ${submission.totalPaid} cents): the organiser owes a refund`
      );
    }

    // Run on a replay too: each effect is flagged on the row, so this finishes only what a previous
    // call left undone (a failed grant, a crash after the commit) and repeats nothing.
    await this.fulfilPayment(submission, outcome.status === 'paid', {
      grantedBy: 'system',
      paymentMethod: 'online',
      metadata: { submissionId, sessionId: sessionId ?? null },
    });
    return { ok: true };
  }

  /**
   * Marks a pending submission as cancelled.
   * The submitter may cancel their own pending submission; form managers may cancel any.
   * Never touches paid submissions.
   */
  async cancelSubmission(submissionId: string, callerId: string, isGlobalAdmin: boolean) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.userId !== callerId) {
      await this.assertFormManager(submission.formId, callerId, isGlobalAdmin);
    }
    // An online answer's request is settled first, by the same rules as a retry (D2): cancelling
    // the row while its request stays payable is how a payment lands on a cancelled answer.
    if (submission.paymentStatus === 'pending') {
      if (submission.paymentRequestId || submission.stripeSessionId) {
        const form = await this.formRepo.findOne({ where: { id: submission.formId } });
        if (!form) throw new NotFoundException('Form not found');
        if ((await this.settleOpenRequest(submission, form)) === 'paid') {
          return { ok: false, alreadyPaid: true };
        }
      } else if (
        (await this.submissionRepo.count({
          where: livePendingWhere(submission.formId, { id: submissionId }),
        })) > 0
      ) {
        throw this.previousPaymentOpen(submissionId, 'its request is being issued');
      }
    }
    // Only while the row still names the request just settled: a retry may have issued another.
    return this.applyPendingCancel(
      submissionId,
      'its submitter or a manager',
      (s) =>
        s.paymentRequestId === submission.paymentRequestId &&
        s.stripeSessionId === submission.stripeSessionId
    );
  }

  /**
   * Asks the provider whether an online answer was paid, from the request the ROW names, and
   * records the payment if so - the payer's return page calls it (`confirm-payment`), so a
   * payment whose confirm callback never arrived is still confirmed while the payer is looking.
   *
   * Asked of a `pending` row AND of an `expired` or `cancelled` one that names a request: a
   * payment made at the end of the hold whose callback is lost leaves the row `expired` with no
   * seat, and `markPaid` already decides a late payment from the row (`paid` while the form has
   * room, else `paid_over_capacity`). The row is re-checked under its lock to still name the uuid
   * that was read (`markPaid`'s `onlyIfRowNames`).
   *
   * It is the only confirmation besides the callback. `verify-session` used to be the other one
   * and never worked: it took the submission from the `order_ref` Lydia's `request/state` was
   * supposed to echo, and no variant of that call echoes it (sandbox, 2026-10-15, payments.md).
   * Here nothing comes from the client but the submission id the caller is allowed to read: the
   * request is the row's own uuid and the answer is Lydia's, read server to server.
   *
   * `declined` (the payer refused: Lydia sends no callback for it) and `cancelled-or-expired`
   * RELEASE a `pending` row (`releaseSettledRefusedRow`): nothing is payable any more, and the
   * payer would otherwise read "pending" with no way to retry until the hold ends. `open` and
   * `unknown` leave the row as it is (the callback, the next read or the expiry job decides), and
   * a failed read is logged at WARN and answered with the row unchanged. Nothing here charges.
   *
   * Answers the submission plus `requestState`, the typed state read on this call (absent when
   * none was), so the page can say "declined, you can try again" from a fact.
   */
  async confirmPayment(submissionId: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    const sessionId = this.lydiaRequestToRead(submission, 'confirmPayment');
    let requestState: RequestState | undefined;
    if (sessionId) {
      const form = await this.formRepo.findOne({ where: { id: submission.formId } });
      const connectAccountId = form?.associationId
        ? await this.associationsService.getPaymentAccountId(form.associationId)
        : null;
      if (!connectAccountId) {
        this.logger.warn(
          `[Forms] confirmPayment ${submissionId}: the form has no payment account to read request ${sessionId} with`
        );
      } else {
        const outcome = await this.settleFromProvider(
          submissionId,
          sessionId,
          connectAccountId,
          'confirmPayment'
        );
        if (outcome !== 'stale' && outcome !== 'unreadable') {
          requestState = outcome;
          if (SETTLED_REFUSED_REQUEST_STATES.has(outcome)) {
            // Declined by the payer (Lydia sends NO callback for it) or cancelled / expired: the
            // request can never be paid, so the answer stops waiting on it NOW and the payer may
            // retry, instead of reading "pending" until the hold ends. Only while the row still
            // names THIS request: a retry that replaced it is waiting on another one.
            await this.releaseSettledRefusedRow(submissionId, sessionId, outcome);
          }
        }
      }
    }
    // `requestState` only when it was read on THIS call AND is still about the row's request: the
    // page decides "declined, try again" from it. A retry that replaced the request between the
    // read and now (another tab, the success page polling while the payer retries) makes the state
    // read a stale one - answering it would offer a retry that cancels the request being paid.
    // The row is read ONCE here, and both the check and the answer come from that read.
    const current = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!current) throw new NotFoundException('Submission not found');
    if (requestState !== undefined && current.stripeSessionId !== sessionId) {
      this.logger.log(
        `[Forms] confirmPayment ${submissionId}: request ${sessionId} read ${requestState}, but the row now names another request - state not answered`
      );
      requestState = undefined;
    }
    return { ...(await this.submitterAnswer(current)), requestState };
  }

  /**
   * THE GUEST RETURN PAGE'S ONE CALL (WP-P2): the answer a receipt proves, confirmed exactly as a
   * member's return confirms it (`confirmPayment`: Lydia read server to server about the row's OWN
   * request), and answered as a `GuestReceiptView` - an allowlist that carries no id.
   *
   * THE RECEIPT IS THE ONLY KEY. The row is found by the receipt's HASH and by nothing else. A
   * malformed receipt, an unknown one, a submission id, or a stored hash handed back as a receipt
   * all answer the same 404 (`GUEST_RECEIPT_NOT_FOUND`): nothing tells a guess that reached a row
   * from one that did not. A receipt replayed after settlement only reads - `confirmPayment` asks
   * the provider nothing about a settled row, and `markPaid` repeats nothing - and nothing the
   * return URL carries besides the receipt is read at all: only Lydia's answer marks a row paid.
   */
  async confirmGuestReceipt(token: unknown): Promise<GuestReceiptView> {
    const row = isGuestReceiptShape(token)
      ? await this.submissionRepo.findOne({
          where: { guestReceiptHash: hashGuestReceipt(token) },
          select: { id: true },
        })
      : null;
    if (!row) {
      // A real guest's receipt never expires, so this is a mistyped link, a deleted answer or a
      // guess. Nothing of the receipt is logged: it is the credential.
      this.logger.warn('[Forms] guest receipt refused: it matches no answer');
      throw new NotFoundException(GUEST_RECEIPT_NOT_FOUND);
    }
    const view = toGuestReceiptView(await this.confirmPayment(row.id));
    this.logger.log(
      `[Forms] guest receipt read: submission ${row.id} is ${view.paymentStatus}` +
        (view.requestState ? ` (provider ${view.requestState})` : '')
    );
    return view;
  }

  /**
   * Moves a `pending` row whose request the provider reports declined or cancelled / expired to
   * `cancelled`, under the row lock and only while the row still names that request (`sessionId`).
   * A row that already left `pending` (expired by the job, cancelled by a callback) is left as is.
   */
  private async releaseSettledRefusedRow(
    submissionId: string,
    sessionId: string,
    state: RequestState
  ): Promise<void> {
    const outcome = await this.moveLockedSubmission(submissionId, 'pending', 'cancelled', {
      named: (s) => s.stripeSessionId === sessionId,
    });
    if (typeof outcome === 'object') {
      this.logger.log(
        `[Forms] confirmPayment ${submissionId}: request ${sessionId} is ${state} at the provider - answer released, the payer may retry`
      );
    } else {
      this.logger.log(
        `[Forms] confirmPayment ${submissionId}: request ${sessionId} is ${state}, row left as is (${outcome})`
      );
    }
  }

  /**
   * A Lydia confirm callback, VERIFIED by core-service with the Business key of `vendorToken`, used
   * as a TRIGGER and nothing more: the row settles from its OWN stored request uuid, read at Lydia
   * with that Business (`settleFromProvider`, the very read the payer's return makes). Nothing the
   * callback carries - amount, request id - decides the status.
   *
   * CROSS-ASSOCIATION CHECK FIRST: the row's payee account (its form's association, or that
   * association's approved parent) must be `vendorToken`. Without it, an authentic callback of
   * association A's request naming a submission of association B in its `order_ref` would settle
   * B's row - A's key is genuine, the row is not A's. Refused rows are logged at ERROR: they are
   * either a forged `order_ref` signed by a real Business, or a delegation that moved mid-payment.
   *
   * Answers `{ outcome }` for core-service's log: the state read, or why nothing was read.
   */
  async confirmPaymentFromCallback(
    submissionId: string,
    callback: { vendorToken: string; requestId?: string }
  ): Promise<{ outcome: string }> {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (!(await this.isCallbackPayee(submission, callback.vendorToken, 'confirm'))) {
      return { outcome: 'other-account' };
    }
    if (
      callback.requestId &&
      submission.paymentRequestId &&
      submission.paymentRequestId !== callback.requestId
    ) {
      // Expected never: a retry cancels the old request before issuing the next, and settles it
      // first if it was paid (`settleOpenRequest`). A confirm for a request the row no longer names
      // is a payment nothing will record - ERROR, so the refund is not owed in silence.
      this.logger.error(
        `[Forms] confirm callback for submission ${submissionId} names request ${callback.requestId}, ` +
          `the row's is ${submission.paymentRequestId}: if Lydia took that payment, a refund is owed - reading the row's own request`
      );
    }
    const sessionId = this.lydiaRequestToRead(submission, 'confirm callback');
    if (!sessionId) return { outcome: `nothing-to-read (${submission.paymentStatus})` };
    return {
      outcome: await this.settleFromProvider(
        submissionId,
        sessionId,
        callback.vendorToken,
        'confirm callback'
      ),
    };
  }

  /**
   * Whether `vendorToken` - the Business whose key verified a callback - is the account this row's
   * money is paid into. Logs the refusal at ERROR (see `confirmPaymentFromCallback`).
   */
  private async isCallbackPayee(
    submission: Submission,
    vendorToken: string,
    what: string
  ): Promise<boolean> {
    const form = await this.formRepo.findOne({
      where: { id: submission.formId },
      select: { id: true, associationId: true },
    });
    const payee = form?.associationId
      ? await this.associationsService.getLydiaPayeeAccountId(form.associationId)
      : null;
    if (payee && payee === vendorToken) return true;
    this.logger.error(
      `[Forms] ${what} callback for submission ${submission.id} REFUSED: verified for a Business ` +
        `that is not the row's payee (${payee ? 'the form pays into another account' : 'the form has no Lydia payee'}) - nothing written`
    );
    return false;
  }

  /**
   * The Lydia `request_uuid` a row's payment can be read with, or null (logged) when there is
   * nothing to ask the provider: a status that cannot become paid, no stored request, or a
   * Stripe-era `cs_...` id that core would refuse with a 400 on every poll.
   */
  private lydiaRequestToRead(submission: Submission, by: string): string | null {
    const sessionId = submission.stripeSessionId;
    if (!CONFIRMABLE_PAYMENT_STATUSES.has(submission.paymentStatus) || !sessionId) {
      this.logger.debug(
        `[Forms] ${by} ${submission.id}: ${submission.paymentStatus}, nothing to ask the provider`
      );
      return null;
    }
    if (!LYDIA_REQUEST_UUID_RE.test(sessionId)) {
      this.logger.log(
        `[Forms] ${by} ${submission.id}: ${submission.paymentStatus} row holds a non-Lydia request id, nothing to ask the provider`
      );
      return null;
    }
    return sessionId;
  }

  /**
   * Reads the row's own request at the provider and records it if paid (`markPaid` under the row
   * lock, re-checking the row still names `sessionId`). The ONE settle both confirmations share -
   * the payer's return and the verified callback. Answers the typed state read (`toRequestState`,
   * via `readRequestState`), `stale` when a retry replaced the request meanwhile, or `unreadable`
   * when the read failed (WARN: the payer repeats it, the callback is retried by Lydia or the expiry
   * job decides). What a `declined` or `cancelled-or-expired` state releases is the caller's call.
   */
  private async settleFromProvider(
    submissionId: string,
    sessionId: string,
    connectAccountId: string,
    by: string
  ): Promise<RequestState | 'stale' | 'unreadable'> {
    try {
      const { state, raw } = await this.readRequestState(sessionId, connectAccountId);
      if (state === 'paid') {
        this.logger.log(
          `[Forms] ${by} ${submissionId}: request ${sessionId} is PAID at the provider - recorded`
        );
        const { ok } = await this.markPaid(submissionId, sessionId, true);
        return ok ? 'paid' : 'stale';
      }
      this.logger.debug(
        `[Forms] ${by} ${submissionId}: request ${sessionId} is ${state} (code ${raw})`
      );
      return state;
    } catch (err: unknown) {
      this.logger.warn(
        `[Forms] ${by} ${submissionId}: could not read request ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 'unreadable';
    }
  }

  /**
   * A Lydia cancel/expire callback, VERIFIED by core-service with the Business key of `vendorToken`,
   * used as a TRIGGER and nothing more - the same rule as `confirmPaymentFromCallback`: the row's
   * OWN request is read at Lydia with that Business (`settleFromProvider`), and only a request Lydia
   * says is `cancelled-or-expired` (state 6, which a cancel and an expiry both leave) or `declined`
   * (state 5) releases the seat (`SETTLED_REFUSED_REQUEST_STATES`). A request
   * Lydia reads `paid` is recorded paid instead; `open`, an unmeasured state or a failed read leaves
   * the row as it is (the expiry job, or Lydia's retry of the callback, decides). So a callback
   * signed by a Business key its payout manager typed cannot cancel a seat Lydia still holds.
   *
   * The report must NAME the request - `requestId` (Lydia's numeric `request_id`, what a callback
   * carries) or `sessionId` (the `request_uuid`) - and is applied only when that is the row's
   * CURRENT request. `submit` reuses a pending row for a new request and cancels the old one first,
   * which makes Lydia call back about the OLD one: applying that would cancel the answer the payer
   * is paying for right now. A row that has no stored id names no request, so no report can match
   * it - it leaves `pending` through the expiry job instead.
   *
   * `vendorToken` is the Business whose key verified the callback: a report about a row whose
   * money goes to another account changes nothing (`isCallbackPayee`).
   *
   * Answers `outcome` for core-service's log; `unreadable` is what core turns into a retryable 503.
   */
  async cancelPendingSubmission(
    submissionId: string,
    request: { requestId?: string; sessionId?: string },
    vendorToken: string
  ): Promise<{ ok: boolean; outcome: string }> {
    if (!request.requestId && !request.sessionId) {
      this.logger.warn(
        `[Forms] cancelPendingSubmission ${submissionId} refused: the report names no request`
      );
      throw new BadRequestException('A cancel report must name its request');
    }
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) {
      this.logger.warn(`[Forms] cancel: submission ${submissionId} not found`);
      return { ok: false, outcome: 'missing' };
    }
    if (!(await this.isCallbackPayee(submission, vendorToken, 'cancel'))) {
      return { ok: false, outcome: 'other-account' };
    }
    const named = (row: Submission) =>
      (!!request.requestId && row.paymentRequestId === request.requestId) ||
      (!!request.sessionId && row.stripeSessionId === request.sessionId);
    if (!named(submission)) {
      // Expected after every reuse: the old request was cancelled on purpose, and Lydia reports it.
      this.logger.log(
        `[Forms] cancel callback for submission ${submissionId} left as is: the reported request ` +
          `is not its current one (${submission.paymentRequestId ?? 'none'})`
      );
      return { ok: true, outcome: 'other-request' };
    }
    const sessionId = this.lydiaRequestToRead(submission, 'cancel callback');
    if (!sessionId) return { ok: true, outcome: `nothing-to-read (${submission.paymentStatus})` };
    const state = await this.settleFromProvider(
      submissionId,
      sessionId,
      vendorToken,
      'cancel callback'
    );
    const settledRefused =
      state !== 'stale' && state !== 'unreadable' && SETTLED_REFUSED_REQUEST_STATES.has(state);
    if (!settledRefused) {
      if (state !== 'paid' && state !== 'stale') {
        this.logger.warn(
          `[Forms] cancel callback for submission ${submissionId}: request ${sessionId} reads ` +
            `${state} at Lydia, neither declined nor cancelled / expired - the seat is kept`
        );
      }
      return { ok: state !== 'unreadable', outcome: state };
    }
    // Under the row lock, the row must still name the very request that was read settled-refused.
    const { ok } = await this.applyPendingCancel(
      submissionId,
      'the provider',
      (row) => named(row) && row.stripeSessionId === sessionId
    );
    return { ok, outcome: state };
  }

  /** Moves a `pending` row to `cancelled` (see `moveLockedSubmission`) and logs the outcome. */
  private async applyPendingCancel(
    submissionId: string,
    by: string,
    named?: (submission: Submission) => boolean
  ): Promise<{ ok: boolean }> {
    const outcome = await this.moveLockedSubmission(submissionId, 'pending', 'cancelled', {
      named,
    });
    if (outcome === 'missing') {
      this.logger.warn(`[Forms] cancel: submission ${submissionId} not found`);
      return { ok: false };
    }
    if (typeof outcome === 'object') {
      this.logger.log(`[Forms] Submission ${submissionId} cancelled by ${by}`);
    }
    return { ok: true };
  }

  /**
   * Moves ONE submission from `from` to `to` under its row lock, and only if it is still in `from`.
   *
   * The read and the write used to be two statements with nothing between them: a cancel or expiry
   * callback that read `pending` could then overwrite a `paid` that `markPaid` committed in between,
   * and a cash validation could be applied twice. The lock makes the check and the move one step.
   * Takes no form lock: none of these moves changes how many seats are held in a way a count could
   * race (a cancel only frees one, a cash validation keeps the one it has). `named`, when given, is
   * read under the same lock: a row whose current request is not the one reported is left as is.
   */
  private async moveLockedSubmission(
    submissionId: string,
    from: string,
    to: string,
    { formId, named }: { formId?: string; named?: (submission: Submission) => boolean } = {}
  ): Promise<{ moved: Submission } | 'missing' | 'not-in-state' | 'other-request'> {
    return this.submissionRepo.manager.transaction('READ COMMITTED', async (manager) => {
      const submission = await manager.findOne(Submission, {
        where: formId ? { id: submissionId, formId } : { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) return 'missing';
      if (submission.paymentStatus !== from) {
        this.logger.debug(
          `[Forms] submission ${submissionId} is ${submission.paymentStatus}, not ${from} - left as is`
        );
        return 'not-in-state';
      }
      if (named && !named(submission)) {
        // Expected after every reuse: the old request was cancelled on purpose, and Lydia reports it.
        this.logger.log(
          `[Forms] submission ${submissionId} left ${from}: the reported request is not its current one (${submission.paymentRequestId ?? 'none'})`
        );
        return 'other-request';
      }
      submission.paymentStatus = to;
      await manager.save(submission);
      return { moved: submission };
    });
  }

  /** Lists submissions waiting for cash validation on a given form. Requires form manager rights. */
  async listPendingCash(formId: string, callerId: string, isGlobalAdmin: boolean) {
    await this.assertFormManager(formId, callerId, isGlobalAdmin);
    const rows = await this.submissionRepo.find({
      where: { formId, paymentStatus: 'pending_cash' },
      order: { createdAt: 'ASC' },
    });
    return rows.map(toManagerView);
  }

  /**
   * Validates a cash submission - marks as paid and grants the tag if configured.
   * Requires form manager rights (form owner or MANAGE_FORMS flag).
   */
  async validateCashPayment(
    formId: string,
    submissionId: string,
    validatedBy: string,
    isGlobalAdmin: boolean
  ) {
    await this.assertFormManager(formId, validatedBy, isGlobalAdmin);
    const outcome = await this.moveLockedSubmission(submissionId, 'pending_cash', 'paid', {
      formId,
    });
    if (outcome === 'missing') throw new NotFoundException('Submission not found');
    if (typeof outcome !== 'object') return { ok: true, message: 'Already processed' };
    this.logger.log(`[Forms] Cash validated for submission ${submissionId} by ${validatedBy}`);

    // Credits the validator rather than `system`, which is why the granter is a parameter.
    await this.fulfilPayment(outcome.moved, true, {
      grantedBy: validatedBy,
      paymentMethod: 'cash',
      metadata: { submissionId, validatedBy, paymentMethod: 'cash' },
    });
    return { ok: true };
  }

  /** Cancels a cash submission awaiting validation. Requires form manager rights. */
  async cancelCashPayment(
    formId: string,
    submissionId: string,
    callerId: string,
    isGlobalAdmin: boolean
  ) {
    await this.assertFormManager(formId, callerId, isGlobalAdmin);
    const outcome = await this.moveLockedSubmission(submissionId, 'pending_cash', 'cancelled', {
      formId,
    });
    if (outcome === 'missing') throw new NotFoundException('Submission not found');
    return { ok: true };
  }

  /** Called by the hourly cron - expires cash submissions past their deadline. */
  async expireStalecashPayments(): Promise<number> {
    const result = await this.submissionRepo
      .createQueryBuilder()
      .update()
      .set({ paymentStatus: 'expired' })
      .where('paymentStatus = :status', { status: 'pending_cash' })
      .andWhere('cashExpiresAt IS NOT NULL')
      .andWhere('cashExpiresAt < NOW()')
      .execute();
    const count = result.affected ?? 0;
    if (count > 0) {
      this.logger.log(`[Forms] Expired ${count} stale cash payment(s)`);
    }
    return count;
  }

  /**
   * Moves every online `pending` submission past the hold to `expired` (PP3).
   *
   * THE SEAT IS ALREADY FREE BEFORE THIS RUNS: every count reads the hold from the row itself
   * (`seatHoldingWhere`), so this job only makes the row SAY what it already is, for the manager's
   * list and the export. It never deletes: the row is the trace a late payment is matched against
   * (`markPaid`). Idempotent from the row - the `WHERE` names the only state it moves out of, so a
   * second run, or two overlapping ones, find nothing left to move.
   */
  async expireStalePendingPayments(): Promise<number> {
    const result = await this.submissionRepo
      .createQueryBuilder()
      .update()
      .set({ paymentStatus: 'expired' })
      .where('"paymentStatus" = :status', { status: 'pending' })
      .andWhere(`"paymentRequestedAt" <= ${PENDING_HOLD_CUTOFF_SQL}`)
      .execute();
    const count = result.affected ?? 0;
    if (count > 0) {
      this.logger.log(`[Forms] Expired ${count} online payment(s) left pending past the hold`);
    }
    return count;
  }

  /**
   * Clears the visitor key of every guest answer that no longer WAITS for its payment (PP5,
   * `guest-visitor.ts`). The key exists to be counted against the ceiling, and only a waiting
   * answer is counted, so it is personal data with nothing left to do: it goes. Run by the expiry
   * job after it has moved stale `pending` rows to `expired`, so those go in the same tick.
   * Idempotent from the rows - the `WHERE` names only keys still set on rows that stopped waiting.
   */
  async forgetSettledGuestVisitors(): Promise<number> {
    const result = await this.submissionRepo
      .createQueryBuilder()
      .update()
      .set({ guestVisitorKey: null })
      .where('"guestVisitorKey" IS NOT NULL')
      .andWhere('"paymentStatus" NOT IN (:...waiting)', { waiting: ['pending', 'pending_cash'] })
      .execute();
    const count = result.affected ?? 0;
    if (count > 0) {
      this.logger.log(`[Forms] Forgot the visitor of ${count} guest answer(s) no longer waiting`);
    }
    return count;
  }

  /** Returns false for empty arrays, empty objects, null, undefined, and empty strings - used to validate required fields. */
  private hasValue(val: any): boolean {
    if (Array.isArray(val)) return val.length > 0;
    if (val && typeof val === 'object') return Object.keys(val).length > 0;
    return !!val;
  }

  /**
   * Adds price modifiers for each selected option to the running total and pushes matching Stripe
   * line-item entries.
   *
   * One modifier per option now, not one per audience: a submitter's audience is expressed by the
   * cell of the pricing grid they land in, and a question the grid prices on is skipped by the
   * caller entirely.
   */
  private calculateModifiers(
    item: any,
    answer: any,
    total: number,
    lines: any[],
    currency: string
  ): number {
    let currentTotal = total;
    const process = (optId: string) => {
      const opt = item.options?.find((o: any) => o.id === optId);
      if (!opt) return;
      const modifier = opt.priceModifier;
      if (modifier > 0) {
        currentTotal += modifier;
        lines.push({
          price_data: {
            currency,
            product_data: { name: `${item.label}: ${opt.label}` },
            unit_amount: modifier,
          },
          quantity: 1,
        });
      }
    };

    if (Array.isArray(answer)) {
      answer.forEach((a) => typeof a === 'string' && process(a));
    } else if (typeof answer === 'string') {
      process(answer);
    }

    return currentTotal;
  }

  /**
   * Returns all submissions for a form enriched with the submitter's first/last name, a payment
   * that landed over capacity first (`overCapacityFirst`): it is the one row the organiser owes
   * something to.
   */
  async getSubmissions(formId: string) {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    // An anonymous form lists in the order of a random id, never of arrival: the order of insertion
    // is a clock the day-precision `createdAt` was cut to hide.
    const subs = overCapacityFirst(
      await this.submissionRepo.find({
        where: { formId },
        order: form?.anonymous ? { id: 'ASC' } : { createdAt: 'DESC' },
      })
    );
    const userIds = [...new Set(subs.map((s) => s.userId).filter(Boolean))];
    const nameMap = new Map<string, { firstName: string | null; lastName: string | null }>();
    if (userIds.length > 0) {
      const rows: { id: string; firstName: string | null; lastName: string | null }[] =
        await this.submissionRepo.manager.query(
          `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [userIds]
        );
      rows.forEach((r) => nameMap.set(r.id, { firstName: r.firstName, lastName: r.lastName }));
    }
    // The files among these answers: a purged one reads "file deleted" instead of offering a
    // download, a live one is saved under its name. Asked only of a form that has a file question.
    const files = hasFileQuestion(form?.items)
      ? await this.formFiles.answerFiles(subs.map((s) => s.id))
      : new Map<string, AnswerFileState>();
    return subs.map((s) => {
      const cited = Object.values(s.answers ?? {}).filter(
        (value): value is string => typeof value === 'string' && files.has(value)
      );
      return {
        ...toManagerView(s),
        firstName: nameMap.get(s.userId)?.firstName ?? null,
        lastName: nameMap.get(s.userId)?.lastName ?? null,
        deletedFileIds: cited.filter((id) => files.get(id)!.purged),
        fileNames: Object.fromEntries(
          cited.filter((id) => !files.get(id)!.purged).map((id) => [id, files.get(id)!.fileName])
        ),
      };
    });
  }

  /**
   * Generates an Excel workbook (.xlsx) with one row per submission and one column per form item.
   *
   * THE WORDS COME FROM THE CALLER AND THIS SERVICE HAS NONE OF ITS OWN. It has no Paraglide, no
   * locale and no way to acquire either, so until 2026-09-22 it wrote `Timestamp`, `First name`,
   * `Amount paid` and the raw `free` enum into a file a French user opens. `labels` is validated by
   * the controller and mirrored by the client's `ExportLabels`.
   *
   * A FREE FORM GETS NEITHER THE AMOUNT COLUMN NOR THE STATUS ONE, the same rule the responses table
   * applies on screen and for the same reason: when `requiresPayment` is false every amount is 0 and
   * every status is `free`, so both columns are one repeated value down the whole sheet.
   */
  async exportSubmissions(
    formId: string,
    labels: ExportLabels
  ): Promise<{ buffer: Buffer; title: string }> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');

    // Same order as the responses list, a payment over capacity first.
    const submissions = overCapacityFirst(
      await this.submissionRepo.find({
        where: { formId },
        order: form.anonymous ? { id: 'ASC' } : { createdAt: 'DESC' },
      })
    );

    // Batch-fetch first/last names for all submitters
    const userIds = [...new Set(submissions.map((s) => s.userId).filter(Boolean))];
    const nameMap = new Map<string, { firstName: string | null; lastName: string | null }>();
    if (userIds.length > 0) {
      const rows: { id: string; firstName: string | null; lastName: string | null }[] =
        await this.formRepo.manager.query(
          `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [userIds]
        );
      rows.forEach((r) => nameMap.set(r.id, { firstName: r.firstName, lastName: r.lastName }));
    }

    const workbook = new ExcelJS.Workbook();
    // Excel sheet names are limited to 31 characters
    const sheetName = form.title.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    // An anonymous form's sheet has no name columns and only a DAY: the time was never stored.
    const headers: Partial<ExcelJS.Column>[] = [
      {
        header: labels.date,
        key: 'date',
        width: 22,
        style: { numFmt: form.anonymous ? 'dd/mm/yyyy' : 'dd/mm/yyyy hh:mm:ss' },
      },
    ];
    if (!form.anonymous) {
      headers.push({ header: labels.firstName, key: 'firstName', width: 20 });
      headers.push({ header: labels.lastName, key: 'lastName', width: 20 });
    }
    if (form.requiresPayment) {
      headers.push({ header: labels.amount, key: 'total', width: 14 });
      headers.push({ header: labels.status, key: 'status', width: 14 });
    }

    form.items.forEach((item: FormItemLike) => {
      headers.push({ header: item.label, key: item.id, width: 30 });
    });

    sheet.columns = headers;

    // A file question's cell is a WORD - the file itself is never exported. The words are the
    // client's, like every other one in this file; a form with a file question and a client that
    // did not send them is refused, not written with the id or with English.
    let words: AnswerWords | undefined;
    if (hasFileQuestion(form.items)) {
      if (!labels.file || !labels.fileDeleted) {
        throw new BadRequestException('export labels "file" and "fileDeleted" are required');
      }
      words = {
        file: labels.file,
        fileDeleted: labels.fileDeleted,
        deletedFiles: await this.formFiles.deletedFileIds(submissions.map((s) => s.id)),
      };
    }

    submissions.forEach((sub) => {
      const names = (sub.userId && nameMap.get(sub.userId)) || { firstName: null, lastName: null };
      const row: Record<string, unknown> = {
        date: sub.createdAt instanceof Date ? sub.createdAt : new Date(sub.createdAt as string),
      };
      if (!form.anonymous) {
        row.firstName = names.firstName ?? '';
        row.lastName = names.lastName ?? '';
      }
      if (form.requiresPayment) {
        row.total = (sub.totalPaid || 0) / 100;
        // A status the client had no word for is written AS STORED and accused in the log: the file
        // must not silently read as if this service had translated it.
        const label = labels.statuses[sub.paymentStatus];
        if (label === undefined)
          this.logger.warn(
            `exportSubmissions: no label for payment status "${sub.paymentStatus}" - writing it raw (form ${formId})`
          );
        row.status = label ?? sub.paymentStatus;
      }

      form.items.forEach((item: FormItemLike) => {
        row[item.id] = answerText(sub.answers[item.id], item, words);
      });

      sheet.addRow(row);
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: form.title };
  }

  /** Subscribes a user to reminders for a form (upsert). Rejects if opensAt is null or already past. */
  async subscribeReminder(formId: string, userId: string) {
    const form = await this.formRepo.findOne({ where: { id: formId, deletedAt: IsNull() } });
    if (!form) throw new NotFoundException('Form not found');
    if (!form.opensAt || new Date(form.opensAt) <= new Date()) {
      throw new BadRequestException('Form is already open or has no scheduled opening time');
    }
    await this.reminderRepo.upsert(
      {
        formId,
        userId,
        opensAt: new Date(form.opensAt),
        notified5min: false,
        notifiedOnOpen: false,
      },
      ['formId', 'userId']
    );
    return { ok: true };
  }

  /** Removes a user's reminder subscription for a form. */
  async unsubscribeReminder(formId: string, userId: string) {
    await this.reminderRepo.delete({ formId, userId });
    return { ok: true };
  }

  /** Returns whether the user has an active reminder subscription for a form. */
  async checkReminder(formId: string, userId: string) {
    const count = await this.reminderRepo.count({ where: { formId, userId } });
    return { subscribed: count > 0 };
  }

  /** Uploads a banner image for a form and updates imageUrl / imageMediaId. */
  async setImageFromUpload(
    formId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    callerId: string,
    isGlobalAdmin: boolean,
    authorization: string | undefined
  ) {
    const form = await this.assertFormManager(formId, callerId, isGlobalAdmin);
    if (!authorization?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing authorization header');
    }
    const mediaId = await this.associationsService.uploadPublicImage(file, authorization);
    const imageUrl = `/api/media/public/${mediaId}`;
    const oldMediaId = form.imageMediaId;
    await this.formRepo.update(formId, { imageMediaId: mediaId, imageUrl });
    if (oldMediaId && oldMediaId !== mediaId) {
      await this.associationsService.deleteMediaBestEffort(oldMediaId, authorization);
    }
    return this.formRepo.findOne({ where: { id: formId } });
  }

  /** Uploads a public image for use in a form question (not tied to the form banner). */
  async uploadItemImage(
    formId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    callerId: string,
    isGlobalAdmin: boolean,
    authorization: string | undefined
  ): Promise<{ imageUrl: string }> {
    await this.assertFormManager(formId, callerId, isGlobalAdmin);
    if (!authorization?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing authorization header');
    }
    const mediaId = await this.associationsService.uploadPublicImage(file, authorization);
    return { imageUrl: `/api/media/public/${mediaId}` };
  }

  /** Removes the banner image from a form. */
  async clearImage(formId: string, callerId: string, isGlobalAdmin: boolean) {
    await this.assertFormManager(formId, callerId, isGlobalAdmin);
    await this.formRepo.update(formId, { imageMediaId: null, imageUrl: null });
    return this.formRepo.findOne({ where: { id: formId } });
  }
}
