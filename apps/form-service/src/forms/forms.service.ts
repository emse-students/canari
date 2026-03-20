import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { Form } from './schemas/form.schema';
import { Submission } from './schemas/submission.schema';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import * as ExcelJS from 'exceljs';

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

@Injectable()
export class FormsService {
  private readonly stripe: Stripe | null;
  private readonly logger = new Logger(FormsService.name);

  constructor(
    @InjectModel(Form.name) private readonly formModel: Model<Form>,
    @InjectModel(Submission.name) private readonly submissionModel: Model<Submission>,
    private readonly configService: ConfigService
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2025-08-27.basil' }) : null;
  }

  async create(input: CreateFormDto) {
    return this.formModel.create({
      ...input,
      items: input.items.map((item) => ({
        ...item,
        id: item.id || makeId('item'),
        options: item.options?.map((opt) => ({
          ...opt,
          id: opt.id || makeId('opt'),
        })),
      })),
    });
  }

  async list(ownerId?: string) {
    const query = ownerId ? { ownerId } : {};
    return this.formModel.find(query).sort({ createdAt: -1 });
  }

  async get(id: string) {
    return this.formModel.findById(id);
  }

  async hasSubmission(formId: string, userId: string): Promise<boolean> {
    const count = await this.submissionModel.countDocuments({ formId, userId });
    return count > 0;
  }

  async submit(id: string, input: SubmitFormDto) {
    const form = await this.formModel.findById(id);
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

      // Calculate modifers based on answers (simplified for now)
      if (answer && item.options?.length) {
        totalCents = this.calculateModifiers(item, answer, totalCents, lineItems, currency);
      }
    }

    const submission = await this.submissionModel.create({
      formId: id,
      userId: input.userId,
      email: input.email,
      answers: input.answers,
      totalPaid: totalCents,
      paymentStatus: totalCents > 0 ? 'pending' : 'free',
    });

    if (totalCents > 0 && this.stripe) {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${this.configService.get('FRONTEND_URL')}/forms/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.configService.get('FRONTEND_URL')}/forms/cancel`,
        line_items: lineItems,
        metadata: {
          submissionId: submission._id.toString(),
          formId: id,
        },
      });

      submission.stripeSessionId = session.id;
      await submission.save();

      return { checkoutUrl: session.url };
    }

    return { message: 'Form submitted successfully', submissionId: submission._id };
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

    if (Array.isArray(answer)) answer.forEach((a) => typeof a === 'string' && process(a));
    else if (typeof answer === 'string') process(answer);

    return currentTotal;
  }

  async getSubmissions(formId: string) {
    return this.submissionModel.find({ formId }).sort({ createdAt: -1 }).exec();
  }

  async exportSubmissions(formId: string): Promise<Buffer> {
    const form = await this.formModel.findById(formId).exec();
    if (!form) throw new NotFoundException('Form not found');

    const submissions = await this.submissionModel.find({ formId }).sort({ createdAt: -1 }).exec();

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

    form.items.forEach((item) => {
      headers.push({ header: item.label, key: item.id, width: 30 });
    });

    sheet.columns = headers;

    submissions.forEach((sub) => {
      const row: any = {
        id: sub._id.toString(),
        userId: sub.userId,
        email: sub.email,
        date: sub.createdAt,
        total: (sub.totalPaid || 0) / 100,
        status: sub.paymentStatus,
      };

      form.items.forEach((item) => {
        row[item.id] = this.formatAnswer(sub.answers[item.id], item);
      });

      sheet.addRow(row);
    });

    return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
  }

  private formatAnswer(ans: any, item: any): string {
    if (!ans) return '';
    if (Array.isArray(ans)) {
      // If options exist, map IDs to labels
      if (item.options?.length) {
        return ans.map((id) => item.options.find((o: any) => o.id === id)?.label || id).join(', ');
      }
      return ans.join(', ');
    }
    if (typeof ans === 'object') {
      // Matrix or similar
      return JSON.stringify(ans);
    }
    // Single option ID
    if (item.options?.length) {
      return item.options.find((o: any) => o.id === ans)?.label || ans;
    }
    return String(ans);
  }
}
