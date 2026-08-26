/* eslint-disable */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import axios from 'axios';
import * as ExcelJS from 'exceljs';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { resolveStripeCallbackUrl } from '../common/stripe-callback-url';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { SubmitterFactsService } from './submitter-facts.service';
import {
  bucketFor,
  dimensionsNeedProfile,
  matchesCondition,
  needsProfile,
  type AudienceCondition,
  type SubmitterFacts,
} from './pricing/audience';
import {
  pricedQuestionIds,
  pricingViewFor,
  resolveCellPrice,
  type CellValue,
  type PriceMatrix,
  type PricingView,
} from './pricing/price-matrix';
import { parseAudienceCondition, parsePriceMatrix, type CriteriaContext } from './pricing/validate';
import { normaliseCondition, visibleItemIds } from './pricing/visibility';

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

/** Dynamic form engine: creation, submission (with optional Stripe checkout), exports, and submission lifecycle. */
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
    private readonly submitterFacts: SubmitterFactsService
  ) {}

  /**
   * Paid forms linked to an association require Stripe Connect onboarding complete.
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
    if (!caller.isGlobalAdmin) {
      const mayGrant = await this.associationsService.callerHasFlag(
        caller.userId,
        assocId,
        AssociationPermissionFlag.MANAGE_MEMBERS
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
  ): Promise<SubmitterFacts> {
    const conditions: (AudienceCondition | null)[] = [
      form.submitCondition,
      ...(form.items ?? []).map((item: any) => normaliseCondition(item)),
    ];
    const needProfile =
      dimensionsNeedProfile(form.priceMatrix?.dimensions ?? []) || conditions.some(needsProfile);
    return this.submitterFacts.build({
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
    facts: SubmitterFacts
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
  private assertMaySubmit(form: Form, facts: SubmitterFacts): void {
    if (!form.submitCondition) return;
    if (matchesCondition(form.submitCondition, facts)) return;
    this.logger.debug(`[FORMS] submit refused by audience condition form=${form.id.slice(0, 8)}`);
    throw new ForbiddenException('This form is not open to you.');
  }

  /** Creates a form and assigns stable IDs to all items and options that lack them. */
  async create(input: CreateFormDto, isGlobalAdmin = false) {
    if (input.associationId && !isGlobalAdmin) {
      const member = await this.associationsService.isMember(input.ownerId!, input.associationId);
      if (!member) {
        throw new ForbiddenException('You are not a member of this association.');
      }
    }
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
      return this.withAssociationNames(await this.formRepo.find({ order: { createdAt: 'DESC' } }));
    }
    const managedAssociations = await this.associationsService.associationsWhereUserHasFlag(
      ownerId,
      AssociationPermissionFlag.MANAGE_FORMS
    );
    const managedIds = managedAssociations.map((a) => a.id);

    const [owned, viaAssociation] = await Promise.all([
      this.formRepo.find({ where: { ownerId }, order: { createdAt: 'DESC' } }),
      managedIds.length === 0
        ? Promise.resolve([])
        : this.formRepo
            .createQueryBuilder('f')
            .where('"f"."associationId" IN (:...managedIds)', { managedIds })
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

  /** Returns a single form by ID with its current submission count, or null if not found. */
  async get(id: string) {
    const form = await this.formRepo.findOne({ where: { id } });
    if (!form) return null;
    const submissionCount = await this.submissionRepo.count({
      where: [
        { formId: id, paymentStatus: 'paid' },
        { formId: id, paymentStatus: 'free' },
        { formId: id, paymentStatus: 'pending' },
        { formId: id, paymentStatus: 'pending_cash' },
      ],
    });
    return { ...form, submissionCount };
  }

  /**
   * Throws ForbiddenException unless the caller is the form owner, a global admin, or a member
   * with MANAGE_FORMS in the form's linked association.
   *
   * There is no third, per-form grant. A form is managed by whoever owns it and by the
   * association's form managers - one axis, set in one place. See `forms.md`.
   * Returns the form so callers can reuse it without a second query.
   */
  async assertFormManager(formId: string, userId: string, isGlobalAdmin: boolean): Promise<Form> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');
    if (isGlobalAdmin || form.ownerId === userId) return form;
    if (form.associationId) {
      const hasFlag = await this.associationsService.callerHasFlag(
        userId,
        form.associationId,
        AssociationPermissionFlag.MANAGE_FORMS
      );
      if (hasFlag) return form;
    }
    throw new ForbiddenException('You are not allowed to manage this form');
  }

  /** Updates a form's metadata and items. Only owner, co-owner, global admin, or MANAGE_FORMS flag may update. */
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

  /** Deletes a form entirely. Requires owner, co-owner, global admin, or MANAGE_FORMS flag. */
  async delete(formId: string, userId: string, isGlobalAdmin: boolean) {
    const form = await this.assertFormManager(formId, userId, isGlobalAdmin);
    await this.formRepo.remove(form);
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
    return this.submissionRepo.findOne({
      where: [
        { formId, userId, paymentStatus: 'paid' },
        { formId, userId, paymentStatus: 'free' },
      ],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Grants the form's configured cotisation tier to a submitter whose payment just landed.
   * Shared by the Stripe webhook path (`markPaid`) and the cash validation path, which had a copy
   * each.
   *
   * Best-effort by design: the payment is a fact by the time this runs, so a failure here must not
   * unwind it - but it is logged as an error, because a paid cotisation that granted nothing is a
   * user who will be told they are not a member.
   */
  private async grantCotisationIfConfigured(
    form: Pick<Form, 'grantsCotisation' | 'cotisationVariantKey' | 'associationId'>,
    userId: string,
    grantedBy: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (!form.grantsCotisation) return;
    if (!form.associationId) {
      this.logger.error(
        '[UserTag] Form grants a cotisation but names no beneficiary association - nothing to be ' +
          'a member of. The create/update DTO must reject this pairing.'
      );
      return;
    }
    try {
      await this.userTagService.grantCotisant(
        form.associationId,
        userId,
        grantedBy,
        form.cotisationVariantKey,
        metadata
      );
    } catch (e) {
      this.logger.error(
        `[UserTag] Failed to grant cotisation tier "${form.cotisationVariantKey ?? 'base'}" of ` +
          `assoc=${form.associationId.slice(0, 8)} to user=${userId.slice(0, 8)}`,
        e
      );
    }
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
    const form = await this.formRepo.findOne({ where: { id: formId } });
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
      const count = await this.submissionRepo.count({
        where: [
          { formId, paymentStatus: 'paid' },
          { formId, paymentStatus: 'free' },
          { formId, paymentStatus: 'pending' },
          { formId, paymentStatus: 'pending_cash' },
        ],
      });
      formFull = count >= form.maxSubmissions;
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

    const submission = await this.submissionRepo.findOne({
      where: [
        { formId, userId, paymentStatus: 'paid' },
        { formId, userId, paymentStatus: 'free' },
        { formId, userId, paymentStatus: 'pending' },
        { formId, userId, paymentStatus: 'pending_cash' },
      ],
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

  /** Validates answers, calculates the total price (base + option modifiers), enforces capacity limits, creates a Submission, and - if totalCents > 0 - returns a Stripe Checkout URL. */
  async submit(id: string, input: SubmitFormDto) {
    const form = await this.formRepo.findOne({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');

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

    // Answers as option-id lists, which is what every criterion reads. A free-text answer is not a
    // criterion input, so it contributes nothing here and keeps its place in `input.answers`.
    const selections: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(input.answers ?? {})) {
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

    // C1+C2: Wrap capacity check + submission upsert in a REPEATABLE READ transaction.
    // Prevents two concurrent requests from both passing the capacity check (C2) and
    // from both creating a new submission for the same user/form (C1 double-charge).
    let savedSubmission!: Submission;
    await this.submissionRepo.manager.transaction('REPEATABLE READ', async (manager) => {
      if (form.maxSubmissions) {
        const count = await manager.count(Submission, {
          where: [
            { formId: id, paymentStatus: 'paid' },
            { formId: id, paymentStatus: 'free' },
            { formId: id, paymentStatus: 'pending' },
            { formId: id, paymentStatus: 'pending_cash' },
          ],
        });
        if (count >= form.maxSubmissions) throw new BadRequestException('Form is full');
      }

      // Reuse an existing pending submission to avoid double-charge, unless multiple
      // submissions are allowed (e.g. order forms where each submit is a new purchase).
      const existingPending =
        totalCents > 0 && !form.allowMultipleSubmissions
          ? await manager.findOne(Submission, {
              where: { formId: id, userId: input.userId, paymentStatus: 'pending' },
              order: { createdAt: 'DESC' },
              lock: { mode: 'pessimistic_write' },
            })
          : null;

      if (existingPending) {
        existingPending.answers = input.answers;
        existingPending.totalPaid = totalCents;
        existingPending.email = input.email;
        savedSubmission = await manager.save(existingPending);
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
    });

    // Cash payment shortcut - skip Stripe entirely
    if (totalCents > 0 && form.allowCashPayment && input.paymentMethod === 'cash') {
      const cashExpiresAt =
        form.cashPaymentExpiryDays != null
          ? new Date(Date.now() + form.cashPaymentExpiryDays * 24 * 60 * 60 * 1000)
          : null;
      savedSubmission.paymentStatus = 'pending_cash';
      savedSubmission.paymentMethod = 'cash';
      savedSubmission.cashExpiresAt = cashExpiresAt;
      await this.submissionRepo.save(savedSubmission);
      this.logger.log(`[Forms] Cash payment pending for submission ${savedSubmission.id}`);
      return { submissionId: savedSubmission.id, cashPayment: true };
    }

    // Stripe minimum is 50 cents for all supported currencies
    const STRIPE_MIN_CENTS = 50;
    if (totalCents > 0 && totalCents < STRIPE_MIN_CENTS) {
      throw new BadRequestException(
        `Total amount (${(totalCents / 100).toFixed(2)} ${currency.toUpperCase()}) is below the Stripe minimum of 0.50 ${currency.toUpperCase()}. Adjust the form price.`
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

      const paymentServiceBase =
        this.configService.get<string>('PAYMENT_SERVICE_URL') || 'http://core-service:3012';
      const checkoutUrl = `${paymentServiceBase.replace(/\/$/, '')}/api/payments/create-checkout-session`;

      try {
        // If the form belongs to an association, route payment via its connected account
        let stripeConnectAccountId: string | undefined;
        if (form.associationId) {
          await this.associationsService.assertPaymentsReady(form.associationId);
          const acctId = await this.associationsService.getPaymentAccountId(form.associationId);
          if (acctId) stripeConnectAccountId = acctId;
        }

        // order_ref for Lydia's request/do callback (see webhook.controller.ts) - never sent for
        // Stripe, which would otherwise read it as its own idempotency key.
        const activeProvider = await this.associationsService.getActivePaymentProvider();
        const idempotencyKey =
          activeProvider === 'lydia' ? `form:${savedSubmission.id}` : undefined;

        // Resolve the Stripe customer ID for the user so the card gets saved after checkout
        let customerId: string | undefined;
        if (input.userId) {
          try {
            const customerResp = await axios.post<{ customerId: string | null }>(
              `${paymentServiceBase.replace(/\/$/, '')}/api/payments/internal/customer-id`,
              { userId: input.userId },
              { maxRedirects: 0 }
            );
            customerId = customerResp.data.customerId ?? undefined;
          } catch {
            // Non-fatal - proceed without customer ID
          }
        }

        const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost';
        const res = await axios.post(checkoutUrl, {
          lineItems: singleLineItem,
          successUrl: resolveStripeCallbackUrl(
            input.successUrl,
            `${frontendUrl}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
            frontendUrl
          ),
          cancelUrl: resolveStripeCallbackUrl(
            input.cancelUrl,
            `${frontendUrl}/forms/cancel?session_id={CHECKOUT_SESSION_ID}`,
            frontendUrl
          ),
          metadata: { submissionId: savedSubmission.id, formId: id, userId: input.userId ?? '' },
          stripeConnectAccountId,
          idempotencyKey,
          // saveForFuture is incompatible with destination charges (Stripe Connect)
          ...(customerId ? { customerId, saveForFuture: !stripeConnectAccountId } : {}),
        });

        const data = res.data || {};
        const sessionUrl = data.url || data.checkoutUrl || null;
        const sessionId = data.id || data.sessionId || null;

        if (!sessionUrl) {
          return {
            message: data.message || 'Payment service did not return a checkout URL',
            submissionId: savedSubmission.id,
          };
        }

        if (sessionId) {
          savedSubmission.stripeSessionId = sessionId;
          await this.submissionRepo.save(savedSubmission);
        }

        return { checkoutUrl: sessionUrl, submissionId: savedSubmission.id };
      } catch (err: any) {
        const stripeMsg =
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.response?.data ||
          err?.message ||
          String(err);
        this.logger.error('Payment service error', stripeMsg);
        throw new BadRequestException(`Failed to create checkout session: ${stripeMsg}`);
      }
    }

    return { message: 'Form submitted successfully', submissionId: savedSubmission.id };
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

  /** Loads a submission by ID with its payment status and the associated Stripe account ID (if any). */
  async getSubmissionById(submissionId: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    const form = await this.formRepo.findOne({ where: { id: submission.formId } });
    return {
      id: submission.id,
      formId: submission.formId,
      userId: submission.userId,
      totalPaid: submission.totalPaid,
      currency: form?.currency ?? 'eur',
      paymentStatus: submission.paymentStatus,
      stripeAccountId: form?.associationId
        ? await this.associationsService.getPaymentAccountId(form.associationId)
        : null,
    };
  }

  /**
   * Records that a submission has been paid, and grants everything that payment buys.
   *
   * THE CALLER IS THE AUTHORISATION, WHICH IS WHY THIS TAKES NO CALLER. Its only route is the
   * internal `X-Internal-Secret` controller, reached from core-service after Stripe's webhook
   * signature has been verified - so by the time this runs, the payment is a fact established
   * somewhere that cannot be spoofed by a client. It used to accept `callerId`/`isGlobalAdmin` and
   * run `assertSubmissionAccess` only `if (callerId)`: a check that quietly did not happen when the
   * argument was absent, behind a public route the SUBMITTER could reach. Both are gone.
   */
  async markPaid(submissionId: string, sessionId?: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    submission.paymentStatus = 'paid';
    if (sessionId) submission.stripeSessionId = sessionId;
    await this.submissionRepo.save(submission);

    // Grant the configured cotisation tier if any + log purchase record
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
    if (form) {
      await this.grantCotisationIfConfigured(form, submission.userId, 'system', {
        submissionId,
        sessionId: sessionId ?? null,
      });
    }
    if (form?.associationId && submission.totalPaid > 0) {
      try {
        await this.purchaseRecordService.create({
          userId: submission.userId,
          source: 'form',
          formId: submission.formId,
          amountCents: submission.totalPaid,
          paymentMethod: 'stripe',
          status: 'paid',
          associationId: form.associationId,
          productName: form.title ?? 'Formulaire',
        });
      } catch (e) {
        this.logger.error(
          `[PurchaseRecord] Failed to record stripe purchase for submission ${submissionId}`,
          e
        );
      }
    }
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
    return this.cancelPendingSubmission(submissionId);
  }

  /**
   * Marks a pending Stripe submission as cancelled without auth checks.
   * Called by core-service when checkout expires or a charge fails definitively.
   */
  async cancelPendingSubmission(submissionId: string): Promise<{ ok: boolean }> {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) {
      this.logger.warn(`[Forms] cancelPendingSubmission: submission ${submissionId} not found`);
      return { ok: false };
    }
    if (submission.paymentStatus !== 'pending') return { ok: true };
    submission.paymentStatus = 'cancelled';
    await this.submissionRepo.save(submission);
    this.logger.log(`[Forms] Submission ${submissionId} cancelled (payment failed or abandoned)`);
    return { ok: true };
  }

  /** Lists submissions waiting for cash validation on a given form. Requires form manager rights. */
  async listPendingCash(formId: string, callerId: string, isGlobalAdmin: boolean) {
    await this.assertFormManager(formId, callerId, isGlobalAdmin);
    return this.submissionRepo.find({
      where: { formId, paymentStatus: 'pending_cash' },
      order: { createdAt: 'ASC' },
    });
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
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId, formId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.paymentStatus !== 'pending_cash') {
      return { ok: true, message: 'Already processed' };
    }
    submission.paymentStatus = 'paid';
    await this.submissionRepo.save(submission);
    this.logger.log(`[Forms] Cash validated for submission ${submissionId} by ${validatedBy}`);

    // Grant the configured cotisation tier if any + log purchase record
    const form = await this.formRepo.findOne({
      where: { id: formId },
      select: {
        id: true,
        title: true,
        grantsCotisation: true,
        cotisationVariantKey: true,
        associationId: true,
      },
    });
    if (form) {
      await this.grantCotisationIfConfigured(form, submission.userId, validatedBy, {
        submissionId,
        validatedBy,
        paymentMethod: 'cash',
      });
    }
    if (form?.associationId && submission.totalPaid > 0) {
      try {
        await this.purchaseRecordService.create({
          userId: submission.userId,
          source: 'form',
          formId: submission.formId,
          amountCents: submission.totalPaid,
          paymentMethod: 'cash',
          status: 'paid',
          associationId: form.associationId,
          productName: form.title ?? 'Formulaire',
        });
      } catch (e) {
        this.logger.error(
          `[PurchaseRecord] Failed to record cash purchase for submission ${submissionId}`,
          e
        );
      }
    }
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
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId, formId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.paymentStatus !== 'pending_cash') return { ok: true };
    submission.paymentStatus = 'cancelled';
    await this.submissionRepo.save(submission);
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

  /** Returns all submissions for a form enriched with the submitter's first/last name. */
  async getSubmissions(formId: string) {
    const subs = await this.submissionRepo.find({
      where: { formId },
      order: { createdAt: 'DESC' },
    });
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
    return subs.map((s) => ({
      ...s,
      firstName: nameMap.get(s.userId)?.firstName ?? null,
      lastName: nameMap.get(s.userId)?.lastName ?? null,
    }));
  }

  /** Generates an Excel workbook (.xlsx) with one row per submission and one column per form item. */
  async exportSubmissions(formId: string): Promise<{ buffer: Buffer; title: string }> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');

    const submissions = await this.submissionRepo.find({
      where: { formId },
      order: { createdAt: 'DESC' },
    });

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

    const headers: any[] = [
      { header: 'Timestamp', key: 'date', width: 22, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
      { header: 'First name', key: 'firstName', width: 20 },
      { header: 'Last name', key: 'lastName', width: 20 },
      { header: 'Amount paid', key: 'total', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
    ];

    form.items.forEach((item: any) => {
      headers.push({ header: item.label, key: item.id, width: 30 });
    });

    sheet.columns = headers;

    submissions.forEach((sub) => {
      const names = nameMap.get(sub.userId) ?? { firstName: null, lastName: null };
      const row: any = {
        date: sub.createdAt instanceof Date ? sub.createdAt : new Date(sub.createdAt as string),
        firstName: names.firstName ?? '',
        lastName: names.lastName ?? '',
        total: (sub.totalPaid || 0) / 100,
        status: sub.paymentStatus,
      };

      form.items.forEach((item: any) => {
        row[item.id] = this.formatAnswer(sub.answers[item.id], item);
      });

      sheet.addRow(row);
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: form.title };
  }

  /** Subscribes a user to reminders for a form (upsert). Rejects if opensAt is null or already past. */
  async subscribeReminder(formId: string, userId: string) {
    const form = await this.formRepo.findOne({ where: { id: formId } });
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

  /** Converts a raw answer value to a human-readable string for the Excel export, resolving option IDs to their labels. */
  private formatAnswer(ans: any, item: any): string {
    if (!ans) return '';
    if (Array.isArray(ans)) {
      if (item.options?.length) {
        return ans.map((id) => item.options.find((o: any) => o.id === id)?.label || id).join(', ');
      }
      return ans.join(', ');
    }
    if (typeof ans === 'object') {
      return JSON.stringify(ans);
    }
    if (item.options?.length) {
      return item.options.find((o: any) => o.id === ans)?.label || ans;
    }
    return String(ans);
  }
}
