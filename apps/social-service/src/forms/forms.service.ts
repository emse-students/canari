/* eslint-disable */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
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

/** Generates a short random ID with the given prefix, e.g. "item_a3b9x1". */
function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** True when the form is configured to collect money for an association recipient. */
function formRequiresStripeReadyAssociation(input: {
  associationId?: string;
  basePrice?: number;
  basePriceMember?: number | null;
  requiresPayment?: boolean;
}): boolean {
  if (!input.associationId?.trim()) return false;
  return (
    (input.basePrice ?? 0) > 0 ||
    (input.basePriceMember ?? 0) > 0 ||
    !!input.requiresPayment
  );
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
    private readonly purchaseRecordService: PurchaseRecordService
  ) {}

  /**
   * Paid forms linked to an association require Stripe Connect onboarding complete.
   * @throws BadRequestException when the association cannot receive payments yet
   */
  private async assertPaidFormAssociationReady(input: {
    associationId?: string;
    basePrice?: number;
    requiresPayment?: boolean;
  }): Promise<void> {
    if (!formRequiresStripeReadyAssociation(input)) return;
    await this.associationsService.assertStripePaymentsReady(input.associationId!.trim());
  }

  /** Creates a form and assigns stable IDs to all items and options that lack them. */
  async create(input: CreateFormDto, isGlobalAdmin = false) {
    if (input.associationId && !isGlobalAdmin) {
      const member = await this.associationsService.isMember(input.ownerId!, input.associationId);
      if (!member) {
        throw new ForbiddenException('Vous n\'êtes pas membre de cette association');
      }
    }
    await this.assertPaidFormAssociationReady(input);
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

  /** Lists all forms where the user is owner or co-owner, newest first. */
  async list(ownerId?: string) {
    if (!ownerId) {
      return this.formRepo.find({ order: { createdAt: 'DESC' } });
    }
    // Fetch owned forms and co-owned forms in parallel without loading the entire table.
    // simple-array stores as CSV so a LIKE scan on UUID is safe (UUIDs don't overlap as substrings).
    const [owned, coOwned] = await Promise.all([
      this.formRepo.find({ where: { ownerId }, order: { createdAt: 'DESC' } }),
      this.formRepo
        .createQueryBuilder('f')
        .where('"f"."ownerId" != :ownerId', { ownerId })
        .andWhere('"f"."coOwners" LIKE :pattern', { pattern: `%${ownerId}%` })
        .orderBy('"f"."createdAt"', 'DESC')
        .getMany(),
    ]);
    return [...owned, ...coOwned].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
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
   * Throws ForbiddenException unless the caller is the form owner, a global admin,
   * a co-owner, or a member with MANAGE_FORMS flag in the form's linked association.
   * Returns the form so callers can reuse it without a second query.
   */
  async assertFormManager(formId: string, userId: string, isGlobalAdmin: boolean): Promise<Form> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');
    if (isGlobalAdmin || form.ownerId === userId) return form;
    if (Array.isArray(form.coOwners) && form.coOwners.includes(userId)) return form;
    if (form.associationId) {
      const hasFlag = await this.associationsService.callerHasFlag(
        userId,
        form.associationId,
        AssociationPermissionFlag.MANAGE_FORMS,
      );
      if (hasFlag) return form;
    }
    throw new ForbiddenException('You are not allowed to manage this form');
  }

  /** Updates a form's metadata and items. Only owner, co-owner, global admin, or MANAGE_FORMS flag may update. */
  async update(formId: string, input: CreateFormDto, userId: string, isGlobalAdmin: boolean) {
    const form = await this.assertFormManager(formId, userId, isGlobalAdmin);
    await this.assertPaidFormAssociationReady(input);
    const { opensAt: opensAtRaw, closedAt: closedAtRaw, ownerId: _ownerId, ...rest } = input;
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

  /** Adds a co-owner to a form. Only the owner or global admin may do this. */
  async addCoOwner(formId: string, coUserId: string, callerId: string, isGlobalAdmin: boolean) {
    // Pessimistic write lock prevents two concurrent add/remove calls from overwriting each other.
    await this.formRepo.manager.transaction(async (manager) => {
      const form = await manager.findOne(Form, {
        where: { id: formId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!form) throw new NotFoundException('Form not found');
      if (!isGlobalAdmin && form.ownerId !== callerId) {
        throw new ForbiddenException('Only the form owner can manage co-owners');
      }
      const coOwners = Array.isArray(form.coOwners) ? [...form.coOwners] : [];
      if (!coOwners.includes(coUserId)) {
        coOwners.push(coUserId);
        await manager.update(Form, formId, { coOwners });
      }
    });
    return { ok: true };
  }

  /** Removes a co-owner from a form. Only the owner or global admin may do this. */
  async removeCoOwner(formId: string, coUserId: string, callerId: string, isGlobalAdmin: boolean) {
    // Pessimistic write lock prevents two concurrent add/remove calls from overwriting each other.
    await this.formRepo.manager.transaction(async (manager) => {
      const form = await manager.findOne(Form, {
        where: { id: formId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!form) throw new NotFoundException('Form not found');
      if (!isGlobalAdmin && form.ownerId !== callerId) {
        throw new ForbiddenException('Only the form owner can manage co-owners');
      }
      const coOwners = (Array.isArray(form.coOwners) ? form.coOwners : []).filter(
        (id) => id !== coUserId
      );
      await manager.update(Form, formId, { coOwners });
    });
    return { ok: true };
  }

  /**
   * Throws ForbiddenException unless the caller is the submitter
   * or passes assertFormManager checks on the parent form.
   */
  async assertSubmissionAccess(submissionId: string, callerId: string, isGlobalAdmin: boolean): Promise<void> {
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

  /** Returns per-user submission state and whether the form has reached its global capacity. */
  async hasSubmission(
    formId: string,
    userId: string,
  ): Promise<{
    hasSubmitted: boolean;
    paymentStatus?: string;
    formFull: boolean;
    memberPricing: boolean;
  }> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) return { hasSubmitted: false, formFull: false, memberPricing: false };

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

    const memberPricing =
      !!userId &&
      !!form.pricingTagName &&
      (await this.userTagService.hasActiveTag(userId, form.pricingTagName));

    if (form.allowMultipleSubmissions) return { hasSubmitted: false, formFull, memberPricing };

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
      memberPricing,
    };
  }

  /** Validates answers, calculates the total price (base + option modifiers), enforces capacity limits, creates a Submission, and - if totalCents > 0 - returns a Stripe Checkout URL. */
  async submit(id: string, input: SubmitFormDto) {
    const form = await this.formRepo.findOne({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');

    if (form.opensAt && new Date(form.opensAt) > new Date()) {
      throw new BadRequestException("Le formulaire n'est pas encore ouvert");
    }

    if (form.closedAt && new Date(form.closedAt) < new Date()) {
      throw new BadRequestException('Le formulaire est fermé');
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

    const memberPricing =
      !!input.userId &&
      !!form.pricingTagName &&
      (await this.userTagService.hasActiveTag(input.userId, form.pricingTagName));

    const baseCents =
      memberPricing && form.basePriceMember != null ? form.basePriceMember : form.basePrice;

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
      const answer = input.answers[item.id];
      if (item.required && !this.hasValue(answer)) {
        throw new BadRequestException(`Missing required field: ${item.label}`);
      }

      // Calculate modifiers
      if (answer && item.options?.length) {
        totalCents = this.calculateModifiers(
          item,
          answer,
          totalCents,
          lineItems,
          currency,
          memberPricing
        );
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
        `Le montant total (${(totalCents / 100).toFixed(2)} ${currency.toUpperCase()}) est inférieur au minimum Stripe de 0,50 ${currency.toUpperCase()}. Ajustez le prix du formulaire.`,
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
        // If the form belongs to an association, route payment via Stripe Connect
        let stripeConnectAccountId: string | undefined;
        if (form.associationId) {
          await this.associationsService.assertStripePaymentsReady(form.associationId);
          const acctId = await this.associationsService.getStripeAccountId(form.associationId);
          if (acctId) stripeConnectAccountId = acctId;
        }

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
  async deleteSubmission(submissionId: string, callerId: string, isGlobalAdmin: boolean): Promise<void> {
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
        ? await this.associationsService.getStripeAccountId(form.associationId)
        : null,
    };
  }

  /**
   * Marks a submission as paid (called from the frontend after Stripe redirect).
   * Requires the caller to be the submitter or a form manager.
   * If the parent form has a `grantedTagName`, grants or renews the tag for the submitter.
   */
  async markPaid(submissionId: string, sessionId?: string, callerId?: string, isGlobalAdmin?: boolean) {
    if (callerId) {
      await this.assertSubmissionAccess(submissionId, callerId, isGlobalAdmin ?? false);
    }
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    submission.paymentStatus = 'paid';
    if (sessionId) submission.stripeSessionId = sessionId;
    await this.submissionRepo.save(submission);

    // Grant cotisation tag if configured on the form + log purchase record
    const form = await this.formRepo.findOne({
      where: { id: submission.formId },
      select: { id: true, title: true, grantedTagName: true, tagExpiresAt: true, associationId: true },
    });
    if (form?.grantedTagName) {
      try {
        await this.userTagService.grantOrRenew({
          userId: submission.userId,
          tagName: form.grantedTagName,
          issuingAssocId: form.associationId ?? null,
          grantedBy: 'system',
          expiresAt: form.tagExpiresAt ?? null,
          metadata: { submissionId, sessionId: sessionId ?? null },
        });
      } catch (e) {
        this.logger.error(`[UserTag] Failed to grant tag for submission ${submissionId}`, e);
      }
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
        this.logger.error(`[PurchaseRecord] Failed to record stripe purchase for submission ${submissionId}`, e);
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
  async validateCashPayment(formId: string, submissionId: string, validatedBy: string, isGlobalAdmin: boolean) {
    await this.assertFormManager(formId, validatedBy, isGlobalAdmin);
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId, formId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.paymentStatus !== 'pending_cash') {
      return { ok: true, message: 'Already processed' };
    }
    submission.paymentStatus = 'paid';
    await this.submissionRepo.save(submission);
    this.logger.log(`[Forms] Cash validated for submission ${submissionId} by ${validatedBy}`);

    // Grant tag if form is configured + log purchase record
    const form = await this.formRepo.findOne({
      where: { id: formId },
      select: { id: true, title: true, grantedTagName: true, tagExpiresAt: true, associationId: true },
    });
    if (form?.grantedTagName) {
      try {
        await this.userTagService.grantOrRenew({
          userId: submission.userId,
          tagName: form.grantedTagName,
          issuingAssocId: form.associationId ?? null,
          grantedBy: validatedBy,
          expiresAt: form.tagExpiresAt ?? null,
          metadata: { submissionId, validatedBy, paymentMethod: 'cash' },
        });
      } catch (e) {
        this.logger.error(`[UserTag] Failed to grant tag after cash validation for ${submissionId}`, e);
      }
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
        this.logger.error(`[PurchaseRecord] Failed to record cash purchase for submission ${submissionId}`, e);
      }
    }
    return { ok: true };
  }

  /** Cancels a cash submission awaiting validation. Requires form manager rights. */
  async cancelCashPayment(formId: string, submissionId: string, callerId: string, isGlobalAdmin: boolean) {
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

  /** Adds price modifiers for each selected option to the running total and pushes matching Stripe line-item entries. */
  private calculateModifiers(
    item: any,
    answer: any,
    total: number,
    lines: any[],
    currency: string,
    memberPricing = false
  ): number {
    let currentTotal = total;
    const process = (optId: string) => {
      const opt = item.options?.find((o: any) => o.id === optId);
      if (!opt) return;
      const modifier = memberPricing ? (opt.priceModifierMember ?? opt.priceModifier) : opt.priceModifier;
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
    const subs = await this.submissionRepo.find({ where: { formId }, order: { createdAt: 'DESC' } });
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
      { header: 'Horodatage', key: 'date', width: 22, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
      { header: 'Prénom', key: 'firstName', width: 20 },
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Montant payé', key: 'total', width: 14 },
      { header: 'Statut', key: 'status', width: 14 },
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
    authorization: string | undefined,
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
