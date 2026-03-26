/* eslint-disable */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import axios from 'axios';
import * as ExcelJS from 'exceljs';

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
    private readonly configService: ConfigService
  ) {}

  async create(input: CreateFormDto) {
    const form = this.formRepo.create({
      ...input,
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

  async list(ownerId?: string) {
    const where = ownerId ? { ownerId } : {};
    return this.formRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  async get(id: string) {
    return this.formRepo.findOne({ where: { id } });
  }

  async getSubmission(formId: string, userId: string) {
    return this.submissionRepo.findOne({
      where: { formId, userId },
      order: { createdAt: 'DESC' },
    });
  }

  async hasSubmission(formId: string, userId: string): Promise<boolean> {
    const count = await this.submissionRepo.count({ where: { formId, userId } });
    return count > 0;
  }

  async submit(id: string, input: SubmitFormDto) {
    const form = await this.formRepo.findOne({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');

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
      const count = await this.submissionRepo.count({ where: { formId: id } });
      if (count >= form.maxSubmissions) throw new BadRequestException('Form is full');
    }

    const submission = this.submissionRepo.create({
      formId: id,
      userId: input.userId,
      email: input.email,
      answers: input.answers,
      totalPaid: totalCents,
      paymentStatus: totalCents > 0 ? 'pending' : 'free',
    });

    const savedSubmission = await this.submissionRepo.save(submission);

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
      const url = `${paymentServiceBase.replace(/\/$/, '')}/api/payments/create-checkout-session`;

      try {
        const res = await axios.post(url, {
          lineItems: singleLineItem,
          successUrl: `${this.configService.get('FRONTEND_URL')}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${this.configService.get('FRONTEND_URL')}/forms/cancel`,
          metadata: { submissionId: savedSubmission.id, formId: id },
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

        return { checkoutUrl: sessionUrl };
      } catch (err: any) {
        this.logger.error('Payment service error', err?.response?.data || err.message || err);
        return { message: 'Failed to create checkout session', submissionId: savedSubmission.id };
      }
    }

    return { message: 'Form submitted successfully', submissionId: savedSubmission.id };
  }

  private hasValue(val: any): boolean {
    if (Array.isArray(val)) return val.length > 0;
    if (val && typeof val === 'object') return Object.keys(val).length > 0;
    return !!val;
  }

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

  async getSubmissions(formId: string) {
    return this.submissionRepo.find({ where: { formId }, order: { createdAt: 'DESC' } });
  }

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
