import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PurchaseRecord } from './entities/purchase-record.entity';

export interface CreatePurchaseData {
  userId: string;
  source: 'form' | 'product';
  formId?: string | null;
  productId?: string | null;
  amountCents: number;
  paymentMethod: 'stripe' | 'cash';
  status: 'paid' | 'pending_cash' | 'cancelled' | 'expired';
  stripePaymentIntentId?: string | null;
  associationId: string;
  productName: string;
}

/** Creates and queries purchase history records across forms and boutique products. */
@Injectable()
export class PurchaseRecordService {
  constructor(
    @InjectRepository(PurchaseRecord)
    private readonly repo: Repository<PurchaseRecord>
  ) {}

  /** Records a completed or pending purchase. */
  async create(data: CreatePurchaseData): Promise<PurchaseRecord> {
    const record = this.repo.create({
      userId: data.userId,
      source: data.source,
      formId: data.formId ?? null,
      productId: data.productId ?? null,
      amountCents: data.amountCents,
      paymentMethod: data.paymentMethod,
      status: data.status,
      stripePaymentIntentId: data.stripePaymentIntentId ?? null,
      associationId: data.associationId,
      productName: data.productName,
    });
    return this.repo.save(record);
  }

  /** Returns all purchase records for a user, newest first. */
  async listByUser(userId: string): Promise<PurchaseRecord[]> {
    return this.repo.find({
      where: { userId },
      order: { paidAt: 'DESC' },
    });
  }

  /** Returns the most recent purchase record matching a Stripe payment intent (for idempotency). */
  async findByPaymentIntent(paymentIntentId: string): Promise<PurchaseRecord | null> {
    return this.repo.findOne({ where: { stripePaymentIntentId: paymentIntentId } });
  }
}
