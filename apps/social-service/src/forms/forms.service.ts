/* eslint-disable */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Form } from './entities/form.entity';
import { retireForms } from './retire-forms';
import {
  PENDING_HOLD_CUTOFF_SQL,
  PAYMENT_REQUEST_LIFETIME_SECONDS,
  PREVIOUS_PAYMENT_OPEN,
  SETTLED_PAYMENT_STATUSES,
  livePendingWhere,
  lockFormSeats,
  overCapacityFirst,
  seatHoldingWhere,
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
import {
  parseAudienceCondition,
  parsePriceMatrix,
  type CriteriaContext,
} from '../pricing/validate';
import { normaliseCondition, visibleItemIds } from './visibility';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import { mapCorePaymentError } from '../common/core-payment-error';
import { PAYMENTS_DISABLED_MESSAGE } from '../associations/payment-delegation.util';

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
 * Whether a form takes money or grants something - the two things that need to know WHO answered.
 * Both an anonymous and a public form refuse them, for that one reason.
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
    private readonly formFiles: FormFilesService
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
   * is nobody to charge, to grant a cotisation to, to match a profile criterion against, or to count
   * once - each is refused where it is chosen, rather than being a setting that quietly does
   * nothing for the people the link reaches. Paying guests are parked behind Lydia (backlog).
   */
  private assertPublicConfigValid(input: CreateFormDto): void {
    if (input.isPublic !== true) return;
    if (takesMoneyOrGrants(input)) {
      throw new BadRequestException(
        'A public form must be free: a guest has no account to charge or to grant a cotisation to.'
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
    const ctx: CriteriaContext = {
      tierKeys: tiers.map((t) => t.variantKey),
      questions: new Map(
        (input.items ?? []).map((item: any) => [
          item.id,
          new Set<string>((item.options ?? []).map((o: any) => o.id).filter(Boolean)),
        ])
      ),
    };

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
    this.assertAnonymousConfigValid({ ...input, items, anonymous: form.anonymous });
    // Unlike anonymity, a link can be opened or withdrawn at any time: it promises nothing about
    // the answers already stored. An absent value means "leave it", so the stored one is checked.
    this.assertPublicConfigValid({ ...input, items, isPublic: input.isPublic ?? form.isPublic });
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
   * user who will be told they are not a member. Returns false ONLY when a retry could succeed (the
   * grant threw), which is what `fulfilPayment` releases its claim on.
   */
  private async grantCotisationIfConfigured(
    form: Pick<Form, 'grantsCotisation' | 'cotisationVariantKey' | 'associationId'>,
    userId: string,
    grantedBy: string,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    if (!form.grantsCotisation) return true;
    if (!form.associationId) {
      this.logger.error(
        '[UserTag] Form grants a cotisation but names no beneficiary association - nothing to be ' +
          'a member of. The create/update DTO must reject this pairing.'
      );
      return true;
    }
    try {
      await this.userTagService.grantCotisant(
        form.associationId,
        userId,
        grantedBy,
        form.cotisationVariantKey,
        metadata
      );
      return true;
    } catch (e) {
      this.logger.error(
        `[UserTag] Failed to grant cotisation tier "${form.cotisationVariantKey ?? 'base'}" of ` +
          `assoc=${form.associationId.slice(0, 8)} to user=${userId.slice(0, 8)}`,
        e
      );
      return false;
    }
  }

  /**
   * Runs what a landed payment buys - the cotisation (only when a seat was given) and the purchase
   * record - each AT MOST ONCE, decided by a durable flag on the row (migration 084).
   *
   * Both effects run after the payment's own transaction committed, so a crash between the two, or
   * a failed grant, used to be lost for good, and a replay used to run both again. Now each effect
   * is CLAIMED first (`claimFulfilment`, a conditional UPDATE only one caller can win) and released
   * if it failed, so the next replay of the same payment retries exactly what is missing. No clock.
   */
  private async fulfilPayment(
    submission: Pick<Submission, 'id' | 'formId' | 'userId' | 'totalPaid'>,
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
    if (seatGiven && (await this.claimFulfilment(submission.id, 'cotisationGrantedAt'))) {
      const granted = await this.grantCotisationIfConfigured(
        form,
        submission.userId,
        how.grantedBy,
        how.metadata
      );
      if (!granted) await this.releaseFulfilment(submission.id, 'cotisationGrantedAt');
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
          status: 'paid',
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
  }

  /** Takes a fulfilment flag if nobody has: true for exactly one caller, ever (until released). */
  private async claimFulfilment(
    submissionId: string,
    flag: 'cotisationGrantedAt' | 'purchaseRecordedAt'
  ): Promise<boolean> {
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
  private async releaseFulfilment(
    submissionId: string,
    flag: 'cotisationGrantedAt' | 'purchaseRecordedAt'
  ): Promise<void> {
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
    const hiddenItemIds = (form.items ?? [])
      .filter((item: any) => {
        const condition = normaliseCondition(item);
        if (!condition) return false;
        const { answer: _answer, ...profileOnly } = condition;
        return Object.keys(profileOnly).length > 0 && !matchesCondition(profileOnly, facts);
      })
      .map((item: any) => item.id);

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

    // The same predicate as the seat count: a checkout abandoned past the hold is no longer "an
    // answer waiting for its payment", so the person may answer again.
    const submission = await this.submissionRepo.findOne({
      where: seatHoldingWhere(formId, { userId }),
      order: { createdAt: 'DESC' },
    });
    return {
      hasSubmitted: !!submission,
      paymentStatus: submission?.paymentStatus,
      formFull,
      pricing,
      hiddenItemIds,
      maySubmit,
    };
  }

  /** Validates answers, calculates the total price (base + option modifiers), enforces capacity limits, creates a Submission, and - if totalCents > 0 - returns a checkout URL. */
  async submit(id: string, input: SubmitFormDto, origin: SubmitOrigin = 'member') {
    const guest = origin === 'guest';
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

    // Answers as option-id lists, which is what every criterion reads. A free-text answer is not a
    // criterion input, so it contributes nothing here and keeps its place in `input.answers`.
    // THE KEYS ARE THE FORM'S OWN QUESTION IDS, AND NOTHING ELSE GETS IN. Every key here comes
    // straight off the request body, so `__proto__` - or `constructor`, or an id this form never
    // declared - is a key a submitter can choose. `Object.create(null)` answers half of that: a
    // prototype-less map has nothing to walk into, so a hostile key cannot reach
    // `Object.prototype` the way it would on an ordinary literal. It does NOT stop the map
    // carrying keys nothing will ever read, which is the other half and the one the analyser kept
    // reporting.
    //
    // THE ALLOWLIST ALREADY EXISTED TWELVE LINES DOWN. `visibleAnswers` is built with
    // `if (visible.has(questionId))`, over a set derived from `form.items` - the same query does
    // not flag it, in this same file. Filtering here changes NOTHING observable: `audience.ts`
    // reads answers BY declared id (`facts.answers[questionId]`) rather than iterating them, the
    // size checks above run over `input.answers` untouched, the per-item loop below reads
    // `input.answers[item.id]` directly, and `visible` is a subset of what is declared - so no
    // key this drops could have reached anything.
    const declaredQuestionIds = new Set((form.items ?? []).map((item: { id: string }) => item.id));
    const selections: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [key, value] of Object.entries(input.answers ?? {})) {
      if (!declaredQuestionIds.has(key)) continue;
      selections[key] = Array.isArray(value) ? (value as string[]) : [String(value)];
    }

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
    if (previous) {
      const settled = await this.settleOpenRequest(previous, form);
      if (settled === 'paid') return { submissionId: previous.id, alreadyPaid: true };
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
      const holdsSeat =
        !!existingPending &&
        (await manager.count(Submission, {
          where: livePendingWhere(id, { id: existingPending.id }),
        })) > 0;

      if (form.maxSubmissions && !holdsSeat) {
        const count = await manager.count(Submission, { where: seatHoldingWhere(id) });
        if (count >= form.maxSubmissions) throw new BadRequestException('Form is full');
      }

      if (form.anonymous || guest) {
        if (!guest && !input.userId) throw new BadRequestException('Sign in to answer this form.');
        // An option supplement could still charge on a form saved free; a charge would need the
        // payer, which is the one thing this branch has none of - by promise, or because a guest
        // has no account at all.
        if (totalCents > 0) {
          throw new BadRequestException(
            guest
              ? 'A public form cannot charge for an option.'
              : 'An anonymous form cannot charge for an option.'
          );
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
            answers: input.answers,
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
        existingPending.answers = input.answers;
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
          userId: input.userId,
          email: input.email,
          answers: input.answers,
          totalPaid: totalCents,
          paymentStatus: totalCents > 0 ? 'pending' : 'free',
          paymentMethod: null,
          cashExpiresAt: null,
        });
        savedSubmission = await manager.save(submission);
      }
      if (fileAnswers.length > 0) {
        await this.formFiles.attach(manager, savedSubmission, id, input.userId!, fileAnswers);
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
      return { submissionId: savedSubmission.id, cashPayment: true };
    }

    // 50-cent floor, inherited from the card processor Canari used before Lydia; Lydia's own minimum is unmeasured
    const MIN_PAYMENT_CENTS = 50;
    if (totalCents > 0 && totalCents < MIN_PAYMENT_CENTS) {
      throw new BadRequestException(
        `Total amount (${(totalCents / 100).toFixed(2)} ${currency.toUpperCase()}) is below the minimum of 0.50 ${currency.toUpperCase()}. Adjust the form price.`
      );
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
        const idempotencyKey = `form:${savedSubmission.id}`;

        const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost';
        const successUrl = resolveCheckoutCallbackUrl(
          input.successUrl,
          `${frontendUrl}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
          frontendUrl
        );
        const cancelUrl = resolveCheckoutCallbackUrl(
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
   *   read as "nobody paid": `request/state` (by the uuid) tells paid (1) from closed (6).
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
      const { data } = await axios.post(
        coreUrl('payments/request-state'),
        { sessionId, connectAccountId },
        internalCoreRequestConfig()
      );
      if (data?.state === 'closed') {
        this.logger.log(`[Forms] submission ${row.id}: request ${sessionId} already closed`);
        return 'free';
      }
      if (data?.state === 'paid') {
        // The person paid the request they are now retrying: the answer is paid, and a second
        // request would charge them twice. Recorded as the callback would record it.
        this.logger.log(
          `[Forms] submission ${row.id}: request ${requestId ?? sessionId} was PAID before the retry - marked paid, no new request issued`
        );
        await this.markPaid(row.id, requestId ?? sessionId);
        return 'paid';
      }
      throw new Error(`request ${sessionId} is ${data?.state ?? 'unknown'} (${data?.raw ?? ''})`);
    } catch (err: unknown) {
      throw this.previousPaymentOpen(row.id, err instanceof Error ? err.message : String(err));
    }
  }

  /** The typed refusal of `settleOpenRequest`, logged at WARN with its reason. */
  private previousPaymentOpen(submissionId: string, reason: string): ConflictException {
    this.logger.warn(
      `[Forms] submission ${submissionId}: previous payment request still open (${reason}) - refused`
    );
    return new ConflictException({
      code: PREVIOUS_PAYMENT_OPEN,
      message: 'The previous payment request is still open. Try again in a moment.',
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
    const form = await this.formRepo.findOne({ where: { id: submission.formId } });
    const { id, formId, totalPaid, paymentStatus } = toSubmitterView(submission);
    return { id, formId, totalPaid, currency: form?.currency ?? 'eur', paymentStatus };
  }

  /**
   * Records that a submission has been paid, and grants everything that payment buys.
   *
   * THE CALLER IS THE AUTHORISATION, WHICH IS WHY THIS TAKES NO CALLER. Its only route is the
   * internal `X-Internal-Secret` controller, reached from core-service after the payment provider's callback
   * signature has been verified - so by the time this runs, the payment is a fact established
   * somewhere that cannot be spoofed by a client. It used to accept `callerId`/`isGlobalAdmin` and
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
   * A SECOND CALL ON A SETTLED ROW IS A REPLAY: the status does not move. It is the ordinary case -
   * the Lydia callback and the payer's `verify-session` both land here for one payment. Before
   * 2026-10-15 each call re-granted and wrote ANOTHER purchase record; now the effects run from
   * durable flags (`fulfilPayment`), so a replay only finishes what is missing.
   *
   * THE REQUEST ID NEVER DECIDES THE STATUS, BUT A FOREIGN ONE IS ACCUSED. The two callers carry two
   * DIFFERENT ids for one payment - the callback's numeric `request_id`, `verify-session`'s
   * `request_uuid` - and the row stores both (`paymentRequestId`, `stripeSessionId`), so a replay
   * naming neither is a second request paid for one answer: logged at ERROR, status unchanged (the
   * money already landed; refusing would only hide it). The id that settled the row is kept in
   * `paymentSettledBy`.
   *
   * ONE ANSWER PER PERSON: on a single-answer form, a late payment whose payer already has another
   * row holding a seat or paid lands `paid_over_capacity`, logged at ERROR.
   */
  async markPaid(submissionId: string, sessionId?: string) {
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
   * Marks a pending online-payment submission as cancelled without auth checks, when the provider
   * reports ITS request cancelled or expired (core-service: Lydia's cancel/expire callback, or the
   * payer returning from the fail URL).
   *
   * The report must NAME the request - `requestId` (Lydia's numeric `request_id`, what a callback
   * carries) or `sessionId` (the `request_uuid`, what the fail URL carries) - and is applied only
   * when that is the row's CURRENT request. `submit` reuses a pending row for a new request and
   * cancels the old one first, which makes Lydia call back about the OLD one: applying that would
   * cancel the answer the payer is paying for right now. A row that has no stored id names no
   * request, so no report can match it - it leaves `pending` through the expiry job instead.
   */
  async cancelPendingSubmission(
    submissionId: string,
    request: { requestId?: string; sessionId?: string }
  ): Promise<{ ok: boolean }> {
    if (!request.requestId && !request.sessionId) {
      this.logger.warn(
        `[Forms] cancelPendingSubmission ${submissionId} refused: the report names no request`
      );
      throw new BadRequestException('A cancel report must name its request');
    }
    const named = (submission: Submission) =>
      (!!request.requestId && submission.paymentRequestId === request.requestId) ||
      (!!request.sessionId && submission.stripeSessionId === request.sessionId);
    return this.applyPendingCancel(submissionId, 'the provider', named);
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
