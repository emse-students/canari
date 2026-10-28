import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import {
  PurchaseRecord,
  RECEIVED_PURCHASE_STATUSES,
  type PurchasePaymentMethod,
  type PurchaseStatus,
} from './entities/purchase-record.entity';

export interface CreatePurchaseData {
  /** NULL for a guest's payment on a public form: a guest has no account. */
  userId: string | null;
  source: 'form' | 'product';
  formId?: string | null;
  productId?: string | null;
  amountCents: number;
  paymentMethod: PurchasePaymentMethod;
  status: PurchaseStatus;
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

  /**
   * Records a completed or pending purchase. `manager` writes it inside the caller's transaction,
   * so a settlement that marks its attempt paid and the record it writes commit together or not at
   * all (`ProductsService.settlePaidCheckout`).
   */
  async create(data: CreatePurchaseData, manager?: EntityManager): Promise<PurchaseRecord> {
    const repo = manager ? manager.getRepository(PurchaseRecord) : this.repo;
    const record = repo.create({
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
    return repo.save(record);
  }

  /**
   * The number of purchases paid for and not granted (`paid_not_granted`), across every association:
   * what the hourly report counts (`PaidNotGrantedScheduler`).
   */
  async countPaidNotGranted(): Promise<number> {
    return this.repo.count({ where: { status: 'paid_not_granted' } });
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

  /** Returns an existing purchase record for a specific user + product combination. */
  async findByUserAndProduct(userId: string, productId: string): Promise<PurchaseRecord | null> {
    return this.repo.findOne({ where: { userId, productId } });
  }

  /**
   * Counts completed product purchases for a user + product. `paid` only: a tier paid for and not
   * granted was not bought.
   */
  async countPaidByUserAndProduct(
    userId: string,
    productId: string,
    manager?: EntityManager
  ): Promise<number> {
    const repo = manager ? manager.getRepository(PurchaseRecord) : this.repo;
    return repo.count({
      where: { userId, productId, source: 'product', status: 'paid' },
    });
  }

  /** Counts all completed purchases for a product (`paid` only, see `countPaidByUserAndProduct`). */
  async countPaidByProduct(productId: string, manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(PurchaseRecord) : this.repo;
    return repo.count({
      where: { productId, source: 'product', status: 'paid' },
    });
  }

  /**
   * Lists the money received for a boutique product, newest first: `paid`, and `paid_not_granted`
   * (a tier paid for and not granted, which a refund or a manual grant must still settle).
   */
  async listPaidByProduct(productId: string): Promise<PurchaseRecord[]> {
    return this.repo.find({
      where: { productId, source: 'product', status: In(RECEIVED_PURCHASE_STATUSES) },
      order: { paidAt: 'DESC' },
    });
  }

  /**
   * Lists the money an association received (boutique + formulaires), newest first, `paid_not_granted`
   * included: those rows are where the association sees a tier paid for and not granted.
   */
  async listPaidByAssociation(associationId: string): Promise<PurchaseRecord[]> {
    return this.repo.find({
      where: { associationId, status: In(RECEIVED_PURCHASE_STATUSES) },
      order: { paidAt: 'DESC' },
    });
  }
}
