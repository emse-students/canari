/* eslint-disable */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/** Generates a short random ID with the given prefix, e.g. "item_a3b9x1". */
function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
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
    private readonly associationsService: AssociationsService
  ) {}

  /** Creates a form and assigns stable IDs to all items and options that lack them. */
  async create(input: CreateFormDto) {
    const { opensAt: opensAtRaw, ...rest } = input;
    const form = this.formRepo.create({
      ...rest,
      opensAt: opensAtRaw ? new Date(opensAtRaw) : null,
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

  /** Lists all forms, optionally filtered by ownerId, newest first. */
  async list(ownerId?: string) {
    const where = ownerId ? { ownerId } : {};
    return this.formRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  /** Returns a single form by ID, or null if not found. */
  async get(id: string) {
    return this.formRepo.findOne({ where: { id } });
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

  /** Returns true if the user already has a completed (paid or free) submission for this form. */
  async hasSubmission(formId: string, userId: string): Promise<boolean> {
    const count = await this.submissionRepo.count({
      where: [
        { formId, userId, paymentStatus: 'paid' },
        { formId, userId, paymentStatus: 'free' },
      ],
    });
    return count > 0;
  }

  /** Validates answers, calculates the total price (base + option modifiers), enforces capacity limits, creates a Submission, and — if totalCents > 0 — returns a Stripe Checkout URL. */
  async submit(id: string, input: SubmitFormDto) {
    const form = await this.formRepo.findOne({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');

    if (form.opensAt && new Date(form.opensAt) > new Date()) {
      throw new BadRequestException('Le formulaire n’est pas encore ouvert');
    }

    // Validation & Price Calculation
    let totalCents = form.basePrice;
    const lineItems: any[] = [];
    const currency = form.currency.toLowerCase();

    if (form.basePrice > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: `${form.title} (Registration)` },
          unit_amount: form.basePrice,
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
        totalCents = this.calculateModifiers(item, answer, totalCents, lineItems, currency);
      }
    }

    if (form.maxSubmissions) {
      const count = await this.submissionRepo.count({
        where: [
          { formId: id, paymentStatus: 'paid' },
          { formId: id, paymentStatus: 'free' },
        ],
      });
      if (count >= form.maxSubmissions) throw new BadRequestException('Form is full');
    }

    // If a pending submission already exists for this user/form, reuse it to avoid duplicates
    const existingPending =
      totalCents > 0
        ? await this.submissionRepo.findOne({
            where: { formId: id, userId: input.userId, paymentStatus: 'pending' },
            order: { createdAt: 'DESC' },
          })
        : null;

    let savedSubmission: Submission;
    if (existingPending) {
      existingPending.answers = input.answers;
      existingPending.totalPaid = totalCents;
      existingPending.email = input.email;
      savedSubmission = await this.submissionRepo.save(existingPending);
    } else {
      const submission = this.submissionRepo.create({
        formId: id,
        userId: input.userId,
        email: input.email,
        answers: input.answers,
        totalPaid: totalCents,
        paymentStatus: totalCents > 0 ? 'pending' : 'free',
      });
      savedSubmission = await this.submissionRepo.save(submission);
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
        this.configService.get<string>('PAYMENT_SERVICE_URL') || 'http://localhost:3012';
      const checkoutUrl = `${paymentServiceBase.replace(/\/$/, '')}/api/payments/create-checkout-session`;

      try {
        // If the form belongs to an association, route payment via Stripe Connect
        let stripeConnectAccountId: string | undefined;
        if (form.associationId) {
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
            // Non-fatal — proceed without customer ID
          }
        }

        const res = await axios.post(checkoutUrl, {
          lineItems: singleLineItem,
          successUrl: `${this.configService.get('FRONTEND_URL')}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${this.configService.get('FRONTEND_URL')}/forms/cancel?session_id={CHECKOUT_SESSION_ID}`,
          metadata: { submissionId: savedSubmission.id, formId: id, userId: input.userId ?? '' },
          stripeConnectAccountId,
          ...(customerId ? { customerId, saveForFuture: true } : {}),
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

  /** Marks a submission as paid (called from the Stripe webhook handler). Optionally stores the Stripe session ID. */
  async markPaid(submissionId: string, sessionId?: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    submission.paymentStatus = 'paid';
    if (sessionId) submission.stripeSessionId = sessionId;
    await this.submissionRepo.save(submission);
    return { ok: true };
  }

  /** Marks a pending submission as cancelled (called when the user abandons checkout). Never touches paid submissions. */
  async cancelSubmission(submissionId: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    // Only cancel pending submissions — never touch paid ones
    if (submission.paymentStatus !== 'pending') return { ok: true };
    submission.paymentStatus = 'cancelled';
    await this.submissionRepo.save(submission);
    return { ok: true };
  }

  /** Returns false for empty arrays, empty objects, null, undefined, and empty strings — used to validate required fields. */
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
    currency: string
  ): number {
    let currentTotal = total;
    const process = (optId: string) => {
      const opt = item.options?.find((o: any) => o.id === optId);
      if (opt && opt.priceModifier > 0) {
        currentTotal += opt.priceModifier;
        lines.push({
          price_data: {
            currency,
            product_data: { name: `${item.label}: ${opt.label}` },
            unit_amount: opt.priceModifier,
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

  /** Returns all submissions for a form in descending creation order. */
  async getSubmissions(formId: string) {
    return this.submissionRepo.find({ where: { formId }, order: { createdAt: 'DESC' } });
  }

  /** Generates an Excel workbook (.xlsx) with one row per submission and one column per form item. */
  async exportSubmissions(formId: string): Promise<Buffer> {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');

    const submissions = await this.submissionRepo.find({
      where: { formId },
      order: { createdAt: 'DESC' },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Submissions');

    // Headers
    const headers: any[] = [
      { header: 'ID', key: 'id', width: 25 },
      { header: 'User', key: 'userId', width: 25 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Paid', key: 'total', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
    ];

    form.items.forEach((item: any) => {
      headers.push({ header: item.label, key: item.id, width: 30 });
    });

    sheet.columns = headers;

    submissions.forEach((sub) => {
      const row: any = {
        id: sub.id,
        userId: sub.userId,
        email: sub.email,
        date: sub.createdAt,
        total: (sub.totalPaid || 0) / 100,
        status: sub.paymentStatus,
      };

      form.items.forEach((item: any) => {
        row[item.id] = this.formatAnswer(sub.answers[item.id], item);
      });

      sheet.addRow(row);
    });

    return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
  }

  /** Subscribes a user to reminders for a form (upsert). Rejects if opensAt is null or already past. */
  async subscribeReminder(formId: string, userId: string) {
    const form = await this.formRepo.findOne({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');
    if (!form.opensAt || new Date(form.opensAt) <= new Date()) {
      throw new BadRequestException('Form is already open or has no scheduled opening time');
    }
    await this.reminderRepo.upsert(
      { formId, userId, opensAt: new Date(form.opensAt), notified5min: false, notifiedOnOpen: false },
      ['formId', 'userId'],
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
