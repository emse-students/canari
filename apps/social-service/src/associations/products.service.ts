import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { firstValueFrom } from 'rxjs';
import * as ExcelJS from 'exceljs';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { ProductCheckout, type ProductCheckoutStatus } from './entities/product-checkout.entity';
import {
  CHECKOUT_EXPIRY_MARGIN_MS,
  CHECKOUT_IN_PROGRESS,
  CHECKOUT_ISSUE_WINDOW_MS,
  COTISATION_DISABLED,
  PREVIOUS_CHECKOUT_OPEN,
  PRODUCT_ALREADY_PURCHASED,
  PRODUCT_COTISANTS_ONLY,
  PRODUCT_REQUEST_LIFETIME_SECONDS,
  PAYMENT_ROUTING_CHANGED,
  productCheckoutLookup,
  PURCHASE_PRICING_CHANGED,
  PURCHASE_ALREADY_CLOSED,
  PURCHASE_BUYER_ERASED,
  PURCHASE_NOT_A_RISE,
  PURCHASE_TIER_NOT_COMPARABLE,
  PURCHASE_HELD_TIER_DELETED,
  PURCHASE_TARGET_ALREADY_HELD,
  PURCHASE_CLOSING_CHANGED,
  PURCHASE_YEAR_OVER,
  PURCHASE_NOT_CLOSABLE,
  PURCHASE_TIER_GONE,
  TIER_NOT_RANKABLE,
  TIER_CHECKOUT_OPEN,
  TIER_HAS_HOLDERS,
  TIER_KEY_EXHAUSTED,
  TIER_KEY_YEAR_SHAPED,
  productOrderRef,
  withCheckoutReturnKey,
} from './product-checkout';
import { PENDING_HOLD_CUTOFF_SQL, toRequestState } from '../forms/seat-hold';
import { isUniqueViolation, violatesUniqueIndex } from '../common/pg-errors';
import { associationVisibleToViewerSql } from '../spaces/reader-spaces';
import { associationVisibleTo } from '../spaces/viewer-visibility';
import { DELETED_ACCOUNT, isErasedAccount } from '../internal/account-erasure';
import { Association } from './entities/association.entity';
import {
  assertReviewerReachesAssociation,
  associationsReachedByReviewer,
} from './review-cohort-reach';
import {
  AssociationsService,
  type LydiaReadinessOutcome,
  type LydiaReadinessRef,
} from './associations.service';
import {
  issuedTagKey,
  TagHeldByAnotherIssuerError,
  UserTagService,
  type CotisationTierInfo,
} from '../users/user-tag.service';
import { lockAssociationTiers, lockBuyerTiers } from '../users/buyer-tier-lock';
import { PurchaseRecordService } from '../users/purchase-record.service';
import {
  PurchaseRecord,
  RECEIVED_PURCHASE_STATUSES,
  receivedStatus,
  type PurchasePaymentMethod,
} from '../users/entities/purchase-record.entity';
import {
  CLOSING_UNIQUE_INDEX,
  PurchaseRecordClosing,
  type PurchaseClosingOutcome,
} from '../users/entities/purchase-record-closing.entity';
import type { UserTag } from '../users/entities/user-tag.entity';
import { resolveCheckoutCallbackUrl } from '../common/checkout-callback-url';
import { CreateProductDto, GrantProductPurchaseDto, UpdateProductDto } from './dto/association.dto';
import {
  type CotisationMode,
  cotisationStem,
  cotisationStemsCollide,
  deriveCotisationTag,
  getAcademicYear,
  tierVariantKeys,
  variantKeyCap,
  VariantKeySpaceExhaustedError,
  variantKeyFromLabel,
  YEAR_SHAPED_VARIANT_KEY,
} from './cotisation-tag.util';
import {
  assertCotisationStemFree,
  stemCollidesElsewhere,
  TIER_TAG_NAME_TAKEN,
} from './cotisation-namespace';
import {
  fixedPriceFor,
  linkedTierKey,
  MEMBER_PRICE_TAG_NOT_A_TIER,
  orphanTierTags,
  pickHeldTier,
  settlementGrants,
  settlementVerdict,
  tierRefusal,
  tierRelationOf,
  type HeldTier,
  type OrphanTierTag,
  type TierRelation,
} from './tier-pricing';
import {
  approvedDelegateIds,
  isDelegating,
  PAYMENTS_DISABLED_MESSAGE,
  resolvePaymentTarget,
  fetchActivePaymentProvider,
  type PaymentProviderId,
  type PaymentTarget,
} from './payment-delegation.util';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { paymentsNotReady } from './lydia-readiness';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import {
  amountOutOfRange,
  classifyCoreCallFailure,
  coreRefusedRequest,
  LYDIA_REFUSALS_FINAL,
  type LydiaRefusalsFinal,
  mapCorePaymentError,
  lydiaReadinessRefusal,
} from '../common/core-payment-error';
import { dimensionsNeedProfile, type PricingFacts } from '../pricing/audience';
import { resolveCellPrice, type CellValue, type PriceMatrix } from '../pricing/price-matrix';
import { parsePriceMatrix, type CriteriaContext } from '../pricing/validate';

/** Delays used between Cercle webhook delivery attempts (ms). The first one is not waited. */
const CERCLE_RETRY_DELAYS = [1_000, 5_000, 15_000];

/**
 * Backoff before each AUTOMATIC retry of a failed delivery (ms), indexed by `autoRetryCount`.
 *
 * Once this list runs out the row stops being picked up and stays in the admin failure list: a
 * delivery still failing a day later is not a transient outage, it is a configuration problem, and
 * retrying it forever would only hide that.
 */
const CERCLE_AUTO_RETRY_BACKOFF = [
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  24 * 3_600_000,
];

/** How many due deliveries one scheduler tick takes, so a backlog cannot stall the service. */
const CERCLE_AUTO_RETRY_BATCH = 20;

/** Same limits as the association logo upload (`AssociationsService.setLogoFromUpload`). */
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_ICON_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * A shop product annotated with the requesting user's cotisation status for its association:
 * whether they hold ANY active tier tag (back-compat `membersOnly`/generic semantics), and which
 * specific tier (`variantKey`) they currently hold, if any (WP-COT-3). Lets the client gate/label
 * members-only products without mirroring the cotisation-tag derivation client-side (both flags
 * are computed authoritatively server-side).
 */
export type ShopProduct = AssociationProduct & {
  viewerIsCotisant: boolean;
  viewerActiveTier: string | null;
  viewerPrice: ViewerPrice;
  /**
   * This product against the tier the viewer holds (`relationOf`, the checkout's own call); `none`
   * for a non-tier.
   */
  viewerTierRelation: TierRelation;
  /**
   * Cents a checkout would charge this viewer now, from the same `fixedPriceFor` / grid cell the
   * checkout uses. Null when the server would refuse the tier (`held`, `lower`, `unranked`) or the
   * membership (`cotisationDisabled`), when the grid does not sell this combination, and for a free
   * amount. Purchase caps and tag gates are not folded in.
   */
  viewerDueCents: number | null;
  /**
   * A membership product whose association has no cotisation mode: the checkout refuses it
   * (`COTISATION_DISABLED`), so the listing says so rather than offer a button that cannot work.
   */
  cotisationDisabled: boolean;
  /**
   * The `variantKey` of the tier this product's `memberPriceTag` names (`linkedTierKey`), so a
   * preferential price can be worded "for holders of" THAT tier - not the first tier the viewer
   * holds. Absent when there is no tag, when it names no tier, or when the viewer's tiers in the
   * association were not read (a guest, no cotisation mode).
   */
  memberPriceTierKey?: string | null;
};

/**
 * What the server knows of one viewer's tiers in one association (`tierFactsFrom`): the
 * association's tier products (on sale or not), every tier whose CURRENT tag the viewer holds, and
 * the one held tier a purchase is ranked against (`pickHeldTier`).
 */
interface TierFacts {
  slug: string;
  tiers: AssociationProduct[];
  /** Tier keys whose current derived tag is held, in `tierVariantKeys` order (named before base). */
  heldKeys: (string | null)[];
  held: HeldTier | null;
}

/** One association's cotisation status for one viewer (see `cotisantStatusFor`). */
interface CotisantStatus {
  isCotisant: boolean;
  activeTier: string | null;
  facts: TierFacts;
}

/**
 * What one viewer pays for one product, resolved server-side.
 *
 * `kind` is the discriminator and not a nicety: "there is no grid" and "the grid closed this
 * combination" are different answers that would otherwise both arrive as a null price, and the
 * second one has to stop the sale while the first one falls back to `amountCents`. A client left
 * to tell them apart would tell them apart wrongly.
 *
 * Resolved here rather than mirrored in the browser because the inputs are not the browser's to
 * know: the promo and the formation come from another service, and the forfait held comes from a
 * tag derivation this side owns.
 */
export interface ViewerPrice {
  /** `fixed`: `amountCents` and the member-price pair apply. `grid`: the matrix decided. */
  kind: 'fixed' | 'grid';
  /**
   * Cents this viewer pays under the grid. `null` means the grid does not sell this combination,
   * so the purchase is refused rather than priced. Always `null` when `kind` is `fixed`, where the
   * product's own columns are the answer.
   */
  amountCents: number | null;
  /**
   * True when the grid rests on the promo or the formation, so a logged-out viewer is being shown
   * the "everyone else" cell rather than their own. What lets the page say so instead of quoting a
   * figure that changes the moment they sign in.
   */
  dependsOnProfile: boolean;
}

/**
 * The membership-product columns a held tier is identified and ranked by (`tierRelation`): the
 * product price, its grid (a gridded tier is not ranked), and the tier key.
 */
const TIER_RANK_COLUMNS = {
  id: true,
  associationId: true,
  variantKey: true,
  amountCents: true,
  priceMatrix: true,
  allowCustomAmount: true,
} as const;

/** What `preparePurchase` fetched from other services, for `decidePurchase` to use under the lock. */
interface PreparedPurchase {
  associationId: string;
  productId: string;
  provider: PaymentProviderId;
  paymentTarget: PaymentTarget;
  vendorToken: string;
  profile: { promo: number | null; formation: string | null };
  /**
   * Whether `profile` was FETCHED: only for a grid priced on promo or formation, as the product read
   * before the lock had one. A grid that needs it under the lock while it was not fetched cannot be
   * priced without a call there (`decidePurchase` refuses `PURCHASE_PRICING_CHANGED`).
   */
  profileFetched: boolean;
}

/**
 * True when two routings send the money to the same place on the same terms - EVERY field of the
 * `PaymentTarget` the request is built from (provider, account, receiving association, readiness,
 * delegation), so one that changed in a field nobody listed is never taken for the same.
 */
function sameRouting(a: PaymentTarget, b: PaymentTarget): boolean {
  return (
    a.provider === b.provider &&
    a.connectAccountId === b.connectAccountId &&
    a.targetAssociationId === b.targetAssociationId &&
    a.ready === b.ready &&
    a.delegated === b.delegated
  );
}

/**
 * One row of an association's purchases list and export: money received, with the buyer's display
 * name, and - for a cotisation tier paid for and not granted - whether a person closed it, and how.
 */
export interface PurchaseListRow {
  id: string;
  userId: string | null;
  source: 'form' | 'product';
  productId: string | null;
  formId: string | null;
  productName: string;
  amountCents: number;
  paymentMethod: PurchasePaymentMethod;
  paidAt: string;
  firstName: string | null;
  lastName: string | null;
  /**
   * Money received for something NOT delivered (`paid_not_granted`, `PurchaseStatus`): a boutique
   * tier not granted at settlement, a product deleted or a buyer erased before the payment landed,
   * or a paid form that grants a tier and did not grant it. A refund or a grant is owed.
   */
  notGranted: boolean;
  /**
   * How a `notGranted` payment was closed (`closePaidNotGranted`, migration 113): `refunded` or
   * `granted`, null while nobody has recorded it - the mark stays, the closing says it is settled.
   */
  closedOutcome: PurchaseClosingOutcome | null;
  /** When the closing was recorded, by the server's clock; null while open. */
  closedAt: string | null;
  /**
   * For an OPEN marked payment, why it cannot be closed as `granted` (`closingGrantVerdict`, the
   * same decision the closing takes under the lock), so the list offers "refunded" only; null when it
   * can be granted, and for every other row.
   */
  grantRefusal: ClosingGrantRefusal | null;
  /**
   * For an OPEN marked payment, the tier its buyer holds NOW (its product name, else its key), so
   * the manager sees what a grant would replace; null when none is held, and for every other row.
   */
  buyerTier: string | null;
  /**
   * For an OPEN marked payment, true when the tier it bought is already held as ITS delivery
   * (`deliveryOf`): closing it as `granted` records that, and grants or replaces nothing.
   */
  delivered: boolean;
}

/** Why a payment paid for and not granted cannot be closed as `granted` (`closingGrantVerdict`). */
export type ClosingGrantRefusal =
  | 'buyer-erased'
  | 'tier-gone'
  | 'year-over'
  | 'target-held'
  | 'not-a-rise'
  | 'not-comparable'
  | 'held-tier-deleted';

/** What `closingGrantVerdict` decided for one marked payment. */
interface ClosingGrantVerdict {
  /** Null when the tier may be granted. */
  refusal: ClosingGrantRefusal | null;
  /** The tier paid for (its CURRENT key); meaningful only when `refusal` is null. */
  variantKey: string | null;
  /** The tier the buyer holds now, by name (`PurchaseListRow.buyerTier`). */
  buyerTier: string | null;
  /**
   * The held tag that IS the delivery of this payment (`deliveryOf`), null otherwise: the closing
   * records `granted`, writes no grant, and stamps that tag with the record so it closes no other.
   */
  deliveredTagId: string | null;
  /** What the decision rests on, for its log line. */
  detail: string;
}

/**
 * The `submissions.paymentStatus` values of an answer whose money is in (`Submission`): what
 * `closingContextOf` counts as a buyer's paid answers to a form.
 */
const PAID_ANSWER_STATUSES = ['paid', 'paid_over_capacity'];

/** What `closingGrantVerdict` reads, loaded once for many records (`closingContextOf`). */
interface ClosingContext {
  asso: Association | null;
  /** The association's tiers with their current tags; empty without a cotisation mode. */
  catalogue: CotisationTierInfo[];
  /** Its membership products, the ranking columns only. */
  tiers: AssociationProduct[];
  /** The records' boutique products, by id (this association's only). */
  products: Map<string, AssociationProduct>;
  /** The records' forms, by id (this association's only). */
  forms: Map<string, { grantsCotisation: boolean; cotisationVariantKey: string | null }>;
  /** Each buyer's ACTIVE tier tags of this association. */
  tagsByBuyer: Map<string, UserTag[]>;
  /**
   * Each buyer's ACTIVE tags of a tier this association no longer has
   * (`UserTagService.heldOrphanTierTagsOf`): a held tier with no price, so a closing ranks
   * `not-comparable` against it, as a checkout does.
   */
  orphansByBuyer: Map<string, OrphanTierTag[]>;
  /**
   * Whether `submissionId` is an answer to the form `record` paid for, by its buyer, who has exactly
   * ONE paid record and ONE paid answer for that form - so that answer can only be this record's
   * (`deliveryOf`).
   */
  ownFormAnswer: (record: PurchaseRecord, submissionId: unknown) => boolean;
}

/**
 * Whether the held tag `tag` - of the tier payment `record` bought - is the DELIVERY of that payment,
 * and why. Read from the tag's own provenance first, then from time:
 * - `metadata.purchaseRecordId` set: the tag already closed (or was granted by) a payment - one
 *   delivery closes at most one payment, so it is not this one's;
 * - `metadata.submissionId` set: a form answer's grant - this payment's only when the record is that
 *   form's, the answer is this buyer's, AND this buyer has exactly ONE paid record AND ONE paid
 *   answer for that form - the answer counted too, since fulfilment writes the record after the
 *   grant and apart from it (`ownSubmission`, `ClosingContext.ownFormAnswer`: a record names no answer, so with two the
 *   answer cannot be told to be this one's) - a replay that raced the run still granting - whatever
 *   the times say;
 * - `metadata.legacy` set: a legacy claim's grant, not a payment's;
 * - `metadata.paymentIntentId` present: a paid grant - this payment's only when it names this
 *   record's payment (both non-null), else a second payment delivered it and this one is owed a
 *   refund; it never falls back to time;
 * - no provenance (a manager's roster grant, which the hourly report asks for): a delivery when first
 *   granted AFTER the payment was recorded (`createdAt` > `paidAt`, both written by the database).
 *   A tag that predates the payment is a renewal the payment did not buy. A revoke followed by a
 *   fresh grant counts as a delivery: the closing is manager-attested (docs/wiki/cotisations.md).
 */
function deliveryOf(
  tag: Pick<UserTag, 'createdAt' | 'metadata'>,
  record: Pick<PurchaseRecord, 'paidAt' | 'stripePaymentIntentId'>,
  ownSubmission: boolean
): { delivered: boolean; detail: string } {
  const meta = tag.metadata ?? {};
  if (meta.purchaseRecordId != null) {
    return { delivered: false, detail: 'its tag is already the delivery of another payment' };
  }
  if (meta.submissionId != null) {
    return ownSubmission
      ? { delivered: true, detail: 'its tag was granted by this form answer' }
      : { delivered: false, detail: 'its tag was granted by another form answer' };
  }
  if (meta.legacy != null) {
    return { delivered: false, detail: 'its tag was granted by a legacy claim' };
  }
  if ('paymentIntentId' in meta) {
    // A paid grant never falls back to time: a null on either side matches nothing.
    return meta.paymentIntentId != null && meta.paymentIntentId === record.stripePaymentIntentId
      ? { delivered: true, detail: 'its tag was granted by this payment' }
      : { delivered: false, detail: 'its tag was granted by another payment, or names none' };
  }
  return tag.createdAt.getTime() > record.paidAt.getTime()
    ? { delivered: true, detail: 'its tag was granted by hand after the payment' }
    : { delivered: false, detail: 'its tag was held before the payment' };
}

/** The typed 409 of each `ClosingGrantRefusal`. */
const CLOSING_GRANT_REFUSALS: Record<ClosingGrantRefusal, { code: string; message: string }> = {
  'buyer-erased': {
    code: PURCHASE_BUYER_ERASED,
    message: "The buyer's account was deleted: only a refund can be recorded.",
  },
  'tier-gone': {
    code: PURCHASE_TIER_GONE,
    message: 'The membership tier this payment was for no longer exists.',
  },
  'year-over': {
    code: PURCHASE_YEAR_OVER,
    message: 'This payment was for an academic year that is over: only a refund can be recorded.',
  },
  'target-held': {
    code: PURCHASE_TARGET_ALREADY_HELD,
    message:
      'The buyer holds this tier, and it was not delivered for this payment: the payment is owed a refund.',
  },
  'not-a-rise': {
    code: PURCHASE_NOT_A_RISE,
    message:
      'The buyer holds a tier worth at least this one: granting it would move them down. Only a refund can be recorded.',
  },
  'not-comparable': {
    code: PURCHASE_TIER_NOT_COMPARABLE,
    message:
      'This tier or the one the buyer holds has no fixed price, so they cannot be compared: only a refund can be recorded.',
  },
  'held-tier-deleted': {
    code: PURCHASE_HELD_TIER_DELETED,
    message:
      'The buyer holds a tier that was deleted, so it cannot be compared with this one. Grant this tier from the members roster (it replaces the deleted one), then close this payment as granted - or record a refund.',
  },
};

/** What `resolvePurchase` decided: the product, its amount for this buyer, and where it is paid. */
interface ResolvedPurchase {
  asso: Association;
  product: AssociationProduct;
  amountCents: number;
  paymentTarget: PaymentTarget;
  /** The paying Business's `vendor_token`: never null once the purchase is allowed. */
  vendorToken: string;
  /**
   * The product id of the tier this purchase was ranked against (`TierFacts.held`), frozen on the
   * attempt row: null when nothing was held or the product is not a tier.
   */
  heldTierProductId: string | null;
}

/** True when a create/update request sets any column member pricing is validated on. */
function touchesMemberPricing(dto: {
  amountCents?: number | null;
  amountCentsMember?: number | null;
  memberPriceTag?: string | null;
}): boolean {
  return (
    dto.amountCents !== undefined ||
    dto.amountCentsMember !== undefined ||
    dto.memberPriceTag !== undefined
  );
}

/** The answer for a product with no grid: its own columns price it, exactly as before. */
const FIXED_PRICE: ViewerPrice = { kind: 'fixed', amountCents: null, dependsOnProfile: false };

/**
 * A product as returned to a client: the Cercle HMAC key is replaced by a boolean saying whether
 * one is set. The admin page needs to know that a webhook is configured; nobody outside this
 * service needs the key itself.
 */
export type SafeProduct = AssociationProduct & { webhookConfigured: boolean };

/**
 * What a cash sale records when the cashier types no amount (`cashSaleQuoteFor`): `priced` (the
 * grid cell or the fixed price, `preferential` when it is the member price), `typed` (a free-amount
 * product: there is no default, an amount must be typed), or `not-sold` (the grid closes this
 * beneficiary's combination: the sale is refused unless an amount is typed).
 */
export type CashSaleQuote =
  | { kind: 'priced'; amountCents: number; preferential: boolean }
  | { kind: 'typed' }
  | { kind: 'not-sold' };

/**
 * A failed Cercle delivery as the admin dashboard sees it: the row, plus who and what it is about.
 *
 * Dates are ISO strings rather than `Date`, so the shape is the same on both sides of the wire.
 */
export interface FailedDelivery {
  id: string;
  productId: string;
  productName: string | null;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  amountCents: number;
  paymentIntentId: string;
  status: 'pending' | 'delivered' | 'failed';
  /** Total sends, across the initial dispatch and every retry since. */
  attemptCount: number;
  /** How many automatic retries have run, which is what picks the next backoff step. */
  autoRetryCount: number;
  lastAttemptAt: string | null;
  /** Null once the automatic ladder is exhausted: this one needs a human. */
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Boutique CRUD, checkout creation, and Cercle webhook dispatch for association products. */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  /** Products whose `memberPriceTag` names no tier, already said at WARN (`memberPriceTierKeyOf`). */
  private readonly warnedMemberPriceTags = new Set<string>();
  /** The Lydia refusal codes a cancel closes an attempt on (`LYDIA_REFUSALS_FINAL`); a test overrides it. */
  protected readonly refusalsFinal: LydiaRefusalsFinal = LYDIA_REFUSALS_FINAL;

  constructor(
    @InjectRepository(AssociationProduct)
    private readonly productRepo: Repository<AssociationProduct>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepo: Repository<WebhookDelivery>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly userTagService: UserTagService,
    private readonly purchaseRecordService: PurchaseRecordService,
    private readonly associationsService: AssociationsService,
    private readonly pricingFacts: PricingFactsService,
    @InjectRepository(ProductCheckout)
    private readonly checkoutRepo: Repository<ProductCheckout>
  ) {}

  /**
   * Strips the Cercle HMAC key from a product before it leaves the service. `webhookSecret` is
   * shared with the Cercle alone - the signature it produces is worth nothing once a JSON response
   * carries the key, and `/products/all` answers every logged-in user. `webhookUrl` stays: it is a
   * public endpoint, and the admin page has to show what is configured.
   */
  private toSafeProduct<T extends AssociationProduct>(
    product: T
  ): T & { webhookConfigured: boolean } {
    return { ...product, webhookSecret: null, webhookConfigured: !!product.webhookSecret };
  }

  /**
   * Resolves the payment target for an association, following an approved parent-payment
   * delegation to the parent's account, against the platform's currently active provider
   * (the Lydia account ids). Loads the parent only when the association
   * actually delegates.
   */
  private async resolvePaymentTargetFor(asso: Association): Promise<PaymentTarget> {
    return this.routeWith(asso, await this.activePaymentProvider());
  }

  /** The platform's active payment provider: a call to core-service. */
  private activePaymentProvider(): Promise<PaymentProviderId> {
    return fetchActivePaymentProvider(this.httpService);
  }

  /**
   * The payment target of `asso` under a provider ALREADY fetched: reads the delegation parent by
   * id and calls nothing, so it may run under a lock (`decidePurchase`, with that transaction's
   * `manager`, so the read uses the lock holder's connection).
   */
  private async routeWith(
    asso: Association,
    provider: PaymentProviderId,
    manager: EntityManager = this.assoRepo.manager
  ): Promise<PaymentTarget> {
    const parent = isDelegating(asso)
      ? await manager.findOne(Association, { where: { id: asso.paymentParentAssociationId } })
      : null;
    return resolvePaymentTarget(asso, parent, provider);
  }

  // ── Pricing grid ──────────────────────────────────────────────────────────

  /**
   * The criteria a product's grid may be built from.
   *
   * `questions` is EMPTY and that is the whole refusal of an `answer` dimension here: a product is
   * not a form and has nothing to answer. Expressing it as an empty catalogue rather than a second
   * list of permitted kinds means there is one rule, not two that can disagree.
   *
   * Tiers are enumerated regardless of `isActive`, like everywhere else that recognizes a forfait:
   * a grid may price on a tier that is no longer sold but is still held.
   */
  private async criteriaContextFor(associationId: string): Promise<CriteriaContext> {
    const tiers = await this.productRepo.find({
      where: { associationId, type: 'membership' },
      select: { variantKey: true },
    });
    return { tierKeys: tierVariantKeys(tiers), questions: new Map() };
  }

  /**
   * Validates a grid a client sent, or refuses it. `null` clears the grid.
   *
   * Structural validation lives in `parsePriceMatrix` for the same reason forms put it there: a
   * criterion's validity depends on the association's own tiers, which no decorator can see.
   */
  private async parseProductMatrix(
    associationId: string,
    raw: unknown
  ): Promise<PriceMatrix | null> {
    if (raw === null || raw === undefined) return null;
    const matrix = parsePriceMatrix(raw, await this.criteriaContextFor(associationId), 'product');
    this.logger.debug(
      `[SHOP] pricing grid accepted: association=${associationId.slice(0, 8)} ` +
        `dimensions=${matrix.dimensions.map((d) => d.kind).join(',')} ` +
        `cells=${Object.keys(matrix.cells).length}`
    );
    return matrix;
  }

  /**
   * What one buyer pays for one gridded product, in cents - or `null` when the grid does not sell
   * their combination.
   *
   * The refusal is the grid's own decision and must be honoured, never rounded up to `amountCents`:
   * a cell set to unavailable is an association saying this forfait is not offered to these people,
   * and charging them a plausible number instead is how a wrong price ships quietly.
   */
  private resolveGridPrice(
    matrix: PriceMatrix,
    cotisationTiers: (string | null)[],
    profile: { promo: number | null; formation: string | null }
  ): CellValue {
    // The profile was fetched BEFORE the buyer's tier lock (`preparePurchase`); the tiers held are
    // the ones `decidePurchase` read under it. Nothing is read here.
    return resolveCellPrice(
      matrix,
      { cotisationTiers, answers: {}, promo: profile.promo, formation: profile.formation },
      'product'
    );
  }

  /**
   * Annotates a batch of products with what THIS viewer pays, one core-service call for the lot.
   *
   * The profile is one person's and is fetched once; the cotisation half differs per association
   * and comes from `statusByAssoc`, which the caller has already loaded in bulk. Doing it per
   * product instead would ask core-service the same question once per row.
   *
   * `statusByAssoc` carries at most one tier per association, which is not a simplification: the
   * sibling-tier XOR is enforced in the same transaction as every grant, so a cotisant holds
   * exactly one forfait of a given association, or none.
   */
  private async viewerPricesFor(
    products: AssociationProduct[],
    userId: string | undefined,
    statusByAssoc: Map<string, CotisantStatus>
  ): Promise<Map<string, ViewerPrice>> {
    const prices = new Map<string, ViewerPrice>();
    // `!= null`, not `!== null`: a product assembled in memory rather than read from a row carries
    // `undefined` here, and "no grid" is the same answer whichever of the two says it.
    const gridded = products.filter(
      (p): p is AssociationProduct & { priceMatrix: PriceMatrix } => p.priceMatrix != null
    );
    if (gridded.length === 0) return prices;

    const needProfile = gridded.some((p) => dimensionsNeedProfile(p.priceMatrix.dimensions));
    const profile = await this.pricingFacts.profileFor(userId, needProfile);

    for (const product of gridded) {
      const status = statusByAssoc.get(product.associationId);
      const facts: PricingFacts = {
        ...profile,
        // No status at all means no cotisation for this association; `activeTier: null` alongside
        // `isCotisant` means the BASE tier, which is a value and not a missing one.
        cotisationTiers: status?.isCotisant ? [status.activeTier] : [],
        answers: {},
      };
      const dependsOnProfile = dimensionsNeedProfile(product.priceMatrix.dimensions);
      let amountCents: number | null;
      try {
        amountCents = resolveCellPrice(product.priceMatrix, facts, 'product');
      } catch (e) {
        // A cell missing at read time is a broken invariant, not a price. Completeness is enforced
        // at save, so this means a grid was written by something that skipped the validator - and
        // the listing must say "not for sale" rather than quote a number nobody chose.
        this.logger.error(
          `[SHOP] pricing grid INCOMPLETE product=${product.id.slice(0, 8)} - listed as unavailable: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
        amountCents = null;
      }
      prices.set(product.id, { kind: 'grid', amountCents, dependsOnProfile });
    }
    return prices;
  }

  // ── Withheld activation ───────────────────────────────────────────────────

  /**
   * Puts on sale the products that were only ever inactive because payments could not be taken.
   *
   * Called when an association's payment target becomes ready - its own Lydia onboarding
   * completing, or a delegation to a parent being approved. Before this existed nothing ever went
   * back: the BDE cotisation was created while onboarding was unfinished, onboarding finished, and
   * the product stayed invisible in the boutique and refused at checkout, with no screen anywhere
   * able to turn it on. Measured 2026-08-31, prod held 5 products and 0 active ones.
   *
   * `activationWithheld` is the ALLOWLIST, never `isActive = false`: a product an admin took off
   * sale is not a product waiting to be released, and the two are only the same column by
   * accident. Setting `isActive` by hand clears the flag, so an admin's decision always wins.
   *
   * Idempotent, and silent when there is nothing to release - it runs on every onboarding event.
   */
  async releaseWithheldProducts(associationId: string): Promise<number> {
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    return this.releaseWithheldFor(asso);
  }

  /**
   * The release itself, for an association already loaded (see `releaseWithheldProducts`).
   *
   * Readiness is RE-READ inside the release's own transaction, the association row (and its
   * delegation parent, the holder whose readiness counts) share-locked: a revert
   * (`AssociationsService.setLydiaReadiness`) locks that holder FOR UPDATE before it withholds, so
   * a release running after a "ready" that a revert has since undone sees the revert and releases
   * nothing - no withheld product goes back on sale while its holder is not ready. Only the
   * provider (a core-service call) is read outside the lock.
   */
  private async releaseWithheldFor(asso: Association): Promise<number> {
    const associationId = asso.id;
    const provider = await this.activePaymentProvider();
    const { count, paymentTarget } = await this.assoRepo.manager.transaction(async (manager) => {
      const fresh = await manager.findOne(Association, {
        where: { id: associationId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!fresh) return { count: 0, paymentTarget: null };
      if (isDelegating(fresh)) {
        await manager.query(`SELECT id FROM associations WHERE id = $1 FOR SHARE`, [
          fresh.paymentParentAssociationId,
        ]);
      }
      const target = await this.routeWith(fresh, provider, manager);
      if (!target.ready) return { count: 0, paymentTarget: target };
      const { affected } = await manager.update(
        AssociationProduct,
        { associationId, activationWithheld: true },
        { isActive: true, activationWithheld: false }
      );
      return { count: affected ?? 0, paymentTarget: target };
    });
    if (!paymentTarget) {
      this.logger.warn(
        `[SHOP] nothing released for association=${associationId.slice(0, 8)}: it no longer exists`
      );
      return 0;
    }
    if (!paymentTarget.ready) {
      this.logger.debug(
        `[SHOP] nothing released for association=${associationId.slice(0, 8)}: payment target not ready ` +
          `(provider=${paymentTarget.provider} delegated=${paymentTarget.delegated})`
      );
      return 0;
    }
    if (count > 0) {
      this.logger.log(
        `[SHOP] released ${count} withheld product(s) for association=${associationId.slice(0, 8)}: ` +
          `payments are ready (provider=${paymentTarget.provider} delegated=${paymentTarget.delegated})`
      );
    }
    return count;
  }

  /**
   * The release for EVERY association holding a withheld product, run when the platform's payment
   * provider stops being `disabled`.
   *
   * Before this, the only trigger was an association's own onboarding completing, so a platform
   * that turned payments on later left every product withheld in the meantime off sale forever
   * (dev end-to-end test, 2026-10-21). The allowlist is still `activationWithheld`; readiness is
   * still resolved per association (own account or delegate's), so an association that is not ready
   * keeps its products withheld. Idempotent: a second run finds the flag already cleared.
   *
   * One failing association must not stop the others, and the failures are COUNTED and returned
   * so the caller can refuse to report success for a sweep that missed some.
   *
   * A withheld product whose association row is GONE is skipped, never counted as a failure:
   * `association_products` has no foreign key to `associations` and deleting an association leaves
   * its products behind, while migration 057 flagged every inactive row of that era. Counting such
   * an orphan as failed would make every activation answer 502 forever for a product nobody can
   * ever sell. The skip is logged (ids only) so the orphan stays visible.
   */
  async releaseWithheldForAllAssociations(): Promise<{ released: number; failed: number }> {
    const rows = await this.productRepo
      .createQueryBuilder('p')
      .select('DISTINCT p.associationId', 'associationId')
      .where('p.activationWithheld = true')
      .getRawMany<{ associationId: string }>();
    const ids = rows.map((r) => r.associationId);
    const associations = ids.length > 0 ? await this.assoRepo.find({ where: { id: In(ids) } }) : [];
    const found = new Set(associations.map((a) => a.id));
    const orphans = ids.filter((id) => !found.has(id));
    this.logger.log(
      `[SHOP] provider activated: ${ids.length} association(s) hold withheld products ` +
        `(${associations.length} exist, ${orphans.length} orphaned)`
    );
    if (orphans.length > 0) {
      this.logger.warn(
        `[SHOP] provider activation SKIPS withheld products whose association no longer exists: ` +
          `association=${orphans.map((id) => id.slice(0, 8)).join(',')}`
      );
    }
    let released = 0;
    let failed = 0;
    for (const asso of associations) {
      try {
        released += await this.releaseWithheldFor(asso);
      } catch (e) {
        failed += 1;
        this.logger.error(
          `[SHOP] release FAILED for association=${asso.id.slice(0, 8)} on provider activation: ` +
            `${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    this.logger.log(`[SHOP] provider activation sweep done: released=${released} failed=${failed}`);
    return { released, failed };
  }

  /**
   * The same release for an association AND every club whose payments it serves.
   *
   * A parent finishing its onboarding makes its approved delegating children ready too, and their
   * products were withheld for exactly the reason that just went away. Sweeping only the
   * association whose row changed would leave every delegating club waiting on an event that has
   * already happened - the same day-late, found-by-hand failure this mechanism exists to end.
   */
  async releaseWithheldForAssociationAndDelegates(associationId: string): Promise<number> {
    // The SAME predicate the readiness revert withholds with (`approvedDelegateIds`), so the
    // release is the exact inverse of the withhold.
    const children = await approvedDelegateIds(this.assoRepo.manager, associationId);
    let total = await this.releaseWithheldProducts(associationId);
    for (const childId of children) {
      // One failing club must not stop the others: this runs after a state change that is already
      // committed, so a throw here would lose every release queued behind it.
      try {
        total += await this.releaseWithheldProducts(childId);
      } catch (e) {
        this.logger.error(
          `[SHOP] release FAILED for delegating child=${childId.slice(0, 8)} of ` +
            `parent=${associationId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return total;
  }

  /**
   * Marks the HOLDER of `vendorToken` ready (`AssociationsService.setLydiaReadiness`, the one
   * writer), then releases its withheld products and its approved delegates' - on EVERY call,
   * replays included: a crash between the commit and the release is healed by the next replay, and
   * `activationWithheld` is the release's allowlist, so a second release finds nothing. The ONE path
   * the webhook's `BUSINESS_VALIDATED` and the global admin's "Valider l'onboarding" take.
   */
  async markLydiaReady(
    vendorToken: string,
    cause: 'webhook-validated' | 'admin',
    ref: LydiaReadinessRef
  ): Promise<LydiaReadinessOutcome> {
    const outcome = await this.associationsService.setLydiaReadiness(vendorToken, true, cause, ref);
    // Nothing became (or already was) ready: nothing to release.
    if (outcome.kind !== 'transitioned' && outcome.kind !== 'replay') return outcome;
    const released = await this.releaseWithheldForAssociationAndDelegates(outcome.associationId);
    this.logger.debug(
      `[SHOP] readiness ${outcome.kind} for association=${outcome.associationId.slice(0, 8)}: ` +
        `${released} withheld product(s) released`
    );
    return outcome;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Returns the active products of every association visible to `userId` (login required, listed
   * on /shop), each annotated for `userId` (`annotateForViewer`). Visible is the directory's
   * predicate, `associationVisibleToViewerSql` (a member of the association, D21, or its rules
   * reach one of the reader's spaces): a product of another campus is no more listed than its
   * association is, and `preparePurchase` refuses it the same way.
   */
  async listAllActive(userId: string): Promise<ShopProduct[]> {
    const all = await this.productRepo
      .createQueryBuilder('p')
      .where('p.isActive = true')
      .andWhere(associationVisibleToViewerSql('"p"."associationId"', ':viewerId'), {
        viewerId: userId,
      })
      .orderBy('p.associationId', 'ASC')
      .addOrderBy('p.sortOrder', 'ASC')
      .addOrderBy('p.createdAt', 'ASC')
      .getMany();
    this.logger.debug(`[SHOP] ${all.length} active product(s) visible to ${userId.slice(0, 8)}`);
    // A review account's shop holds only the associations it is a member of (review-cohort-reach.ts).
    // Already implied by the space predicate (a review account has no real space), kept as the
    // cohort's own stated boundary.
    const reached = await associationsReachedByReviewer(
      this.productRepo.manager,
      userId,
      all.map((p) => p.associationId)
    );
    const products = reached === null ? all : all.filter((p) => reached.has(p.associationId));
    return this.annotateForViewer(products, userId);
  }

  /**
   * Annotates products for one viewer: `viewerIsCotisant`/`viewerActiveTier` so the client can
   * gate/label members-only products without mirroring the cotisation-tag derivation,
   * `viewerPrice` - what a gridded product costs THIS viewer, since a grid rests on facts a browser
   * has no way to evaluate - and `viewerTierRelation`/`viewerDueCents`, so a tier is quoted at the
   * amount the checkout will charge and a client never recomputes money. A guest (`userId`
   * undefined) holds nothing: every relation is `none` and every due amount the full price.
   */
  private async annotateForViewer(
    products: AssociationProduct[],
    userId: string | undefined
  ): Promise<ShopProduct[]> {
    // The associations are read ONCE, for both readers: the viewer's tier facts need their slug and
    // mode, and the cotisation-disabled mark their mode. A guest looking at no membership product
    // needs neither, so nothing is read.
    const needsAssociations = userId !== undefined || products.some((p) => p.type === 'membership');
    const assocIds = [...new Set(products.map((p) => p.associationId))];
    const assos =
      needsAssociations && assocIds.length > 0
        ? await this.assoRepo.find({
            where: { id: In(assocIds) },
            select: { id: true, slug: true, cotisationMode: true },
          })
        : [];
    const statusByAssoc = userId
      ? await this.cotisantStatusFor(userId, assos)
      : new Map<string, CotisantStatus>();
    const viewerPrices = await this.viewerPricesFor(products, userId, statusByAssoc);
    const disabled = this.cotisationDisabledAssociations(products, assos);
    return products.map((p) => {
      const status = statusByAssoc.get(p.associationId);
      const facts = status?.facts ?? null;
      const viewerPrice = viewerPrices.get(p.id) ?? FIXED_PRICE;
      const viewerTierRelation: TierRelation =
        p.type === 'membership' ? this.relationOf(p, facts) : 'none';
      const cotisationDisabled = p.type === 'membership' && disabled.has(p.associationId);
      const memberPriceTierKey = this.memberPriceTierKeyOf(p, facts);
      return this.toSafeProduct({
        ...p,
        viewerIsCotisant: status?.isCotisant ?? false,
        viewerActiveTier: status?.activeTier ?? null,
        viewerPrice,
        viewerTierRelation,
        viewerDueCents: cotisationDisabled
          ? null
          : this.dueCentsFor(p, viewerTierRelation, viewerPrice, facts),
        cotisationDisabled,
        ...(memberPriceTierKey !== undefined ? { memberPriceTierKey } : {}),
      });
    });
  }

  /**
   * The associations, among those `products` sell a membership of, whose cotisations are disabled
   * (no cotisation mode): what the checkout refuses with `COTISATION_DISABLED`
   * (`assertMembershipGrantable`), from the associations the listing already read (`assos`).
   */
  private cotisationDisabledAssociations(
    products: AssociationProduct[],
    assos: Pick<Association, 'id' | 'cotisationMode'>[]
  ): Set<string> {
    const selling = new Set(
      products.filter((p) => p.type === 'membership').map((p) => p.associationId)
    );
    const disabled = new Set(
      assos.filter((a) => selling.has(a.id) && !a.cotisationMode).map((a) => a.id)
    );
    if (disabled.size > 0) {
      this.logger.debug(
        `[SHOP] listing: membership products of ${disabled.size} association(s) with cotisations disabled - not offered`
      );
    }
    return disabled;
  }

  /**
   * What a checkout of `product` would charge this viewer now, from the SAME decisions
   * `resolvePurchase` takes: a refused tier (`held`, `lower`, `unranked`) has no price, a grid
   * answers its cell (null when it does not sell this combination), a fixed price goes through
   * `fixedPriceFor`, and a free amount is the buyer's to choose, so null.
   */
  private dueCentsFor(
    product: AssociationProduct,
    relation: TierRelation,
    viewerPrice: ViewerPrice,
    facts: TierFacts | null
  ): number | null {
    if (relation === 'held' || relation === 'lower' || relation === 'unranked') return null;
    if (product.priceMatrix != null) return viewerPrice.amountCents;
    if (product.amountCents === null) return null;
    return this.fixedPriceOf(product, product.amountCents, facts).amountCents;
  }

  /**
   * `fixedPriceFor` for one buyer, from their tier facts (null: no cotisation in this association).
   * The preferential price of a `memberPriceTag` product applies when the buyer holds, TODAY, the
   * sibling tier the tag names (`memberPriceTierKeyOf`). Without facts (a guest, or an association
   * with no cotisation mode) nothing is held, so no preferential price applies.
   */
  private fixedPriceOf(
    product: AssociationProduct,
    amountCents: number,
    facts: TierFacts | null
  ): { amountCents: number; preferential: boolean } {
    const linked = this.memberPriceTierKeyOf(product, facts);
    const holdsLinkedTier =
      linked !== undefined && facts !== null && facts.heldKeys.includes(linked);
    return fixedPriceFor(
      {
        amountCents,
        amountCentsMember: product.amountCentsMember,
        memberPriceTag: product.memberPriceTag,
      },
      { isCotisant: (facts?.heldKeys.length ?? 0) > 0, holdsLinkedTier }
    );
  }

  /**
   * The `variantKey` of the sibling tier `product.memberPriceTag` names (`linkedTierKey`), or
   * `undefined` when the product has no tag, when there are no facts (the tiers it would be judged
   * against were not read), or when it names no tier of the association. That last case applies no
   * preferential price and is logged at WARN ONCE per product per process (`warnedMemberPriceTags`):
   * create and update refuse to save such a tag, so it is a row written before that rule, or a tier
   * renamed outside `update` - a fact about the row, not about each quote that reads it.
   */
  private memberPriceTierKeyOf(
    product: AssociationProduct,
    facts: TierFacts | null
  ): string | null | undefined {
    if (!product.memberPriceTag || !facts) return undefined;
    const linked = linkedTierKey(
      product.memberPriceTag,
      facts.slug,
      facts.tiers.map((t) => t.variantKey)
    );
    if (linked === undefined && !this.warnedMemberPriceTags.has(product.id)) {
      this.warnedMemberPriceTags.add(product.id);
      this.logger.warn(
        `[SHOP] product=${product.id.slice(0, 8)} memberPriceTag names no cotisation tier of its association - preferential price not applied (said once per product until restart)`
      );
    }
    return linked;
  }

  /**
   * The tier facts of one viewer in one association (`TierFacts`): every tier key whose CURRENT
   * derived tag `holds` answers for (named before base, `tierVariantKeys`), and the one held tier a
   * purchase is ranked against (`pickHeldTier`). Null when the association has no cotisation mode.
   * The single enumeration behind `isBuyerCotisant`, the checkout's rank check, its settlement and
   * the listings, so "is a cotisant", "holds this tier" and "what it costs" cannot drift apart.
   *
   * `orphans` are the viewer's tags of a tier the association no longer has
   * (`UserTagService.heldOrphanTierTags`): ranked as a held tier with no product, so with no price,
   * which makes every purchase of another tier `unranked` - never `none`, which would let a holder
   * of a deleted dearer tier buy a cheaper one. They are not in `heldKeys`: a tier that is gone
   * grants no member price and no gate, as it did before.
   */
  private async tierFactsFrom(
    asso: Pick<Association, 'slug' | 'cotisationMode'>,
    tiers: AssociationProduct[],
    holds: (tagName: string) => boolean | Promise<boolean>,
    orphans: readonly OrphanTierTag[]
  ): Promise<TierFacts | null> {
    if (!asso.cotisationMode) return null;
    const heldKeys: (string | null)[] = [];
    for (const variantKey of tierVariantKeys(tiers)) {
      const { tagName } = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        variantKey
      );
      if (await holds(tagName)) heldKeys.push(variantKey);
    }
    const held = pickHeldTier([
      ...heldKeys.map((variantKey) => ({
        variantKey,
        product: tiers.find((t) => t.variantKey === variantKey) ?? null,
      })),
      ...orphans.map((o) => ({ variantKey: o.variantKey, product: null })),
    ]);
    return { slug: asso.slug, tiers, heldKeys, held };
  }

  /**
   * Given a user and the associations already read (`assos`), returns per-association cotisation
   * status: whether
   * the user holds ANY active tier tag for it (`isCotisant`, back-compat `membersOnly`/generic
   * semantics - see `isBuyerCotisant`), which specific tier (`variantKey`) they hold first in
   * `tierVariantKeys` order (`activeTier`, WP-COT-3), and their `TierFacts`. Loads each
   * association's tiered products and the user's active tags once, so annotating N products costs
   * a fixed number of queries regardless of product count.
   */
  private async cotisantStatusFor(
    userId: string,
    assos: Pick<Association, 'id' | 'slug' | 'cotisationMode'>[]
  ): Promise<Map<string, CotisantStatus>> {
    const byAssoc = new Map<string, CotisantStatus>();
    if (assos.length === 0) return byAssoc;
    const assocIds = assos.map((a) => a.id);
    const [tierProducts, activeTags] = await Promise.all([
      // Every tier, on sale or not: `isActive` gates BUYING a forfait, never recognizing the one
      // a user already holds (see `listCotisationTiers`).
      this.productRepo.find({
        where: { associationId: In(assocIds), type: 'membership' },
        select: TIER_RANK_COLUMNS,
      }),
      this.userTagService.listByUser(userId),
    ]);
    // A tier tag counts only for the association that issued it.
    const activeTagKeys = new Set(activeTags.map((t) => issuedTagKey(t.issuingAssocId, t.tagName)));
    const tiersByAssoc = new Map<string, AssociationProduct[]>();
    for (const p of tierProducts) {
      const list = tiersByAssoc.get(p.associationId) ?? [];
      list.push(p);
      tiersByAssoc.set(p.associationId, list);
    }
    for (const asso of assos) {
      const tiers = tiersByAssoc.get(asso.id) ?? [];
      // The same rows `heldOrphanTierTags` reads, from the tags already loaded: the ones this
      // association issued, in its namespace, naming none of its tiers.
      const orphans = orphanTierTags(
        activeTags.filter((t) => t.issuingAssocId === asso.id).map((t) => t.tagName),
        asso.slug,
        tierVariantKeys(tiers)
      );
      const facts = await this.tierFactsFrom(
        asso,
        tiers,
        (tag) => activeTagKeys.has(issuedTagKey(asso.id, tag)),
        orphans
      );
      if (!facts) continue;
      byAssoc.set(asso.id, {
        isCotisant: facts.heldKeys.length > 0,
        activeTier: facts.heldKeys[0] ?? null,
        facts,
      });
    }
    return byAssoc;
  }

  /**
   * Returns active products for a single association ordered by sortOrder, annotated like the
   * shop (`annotateForViewer`).
   *
   * `userId` is OPTIONAL because this listing is the public association page, read while logged
   * out as often as not. A guest has no promo, no formation and no forfait, so a grid resolves
   * them to its "everyone else" cell - an answer, not a failure, and `dependsOnProfile` is what
   * lets the page say the figure may change once they sign in.
   */
  async listByAssoc(associationId: string, userId?: string): Promise<ShopProduct[]> {
    const products = await this.productRepo.find({
      where: { associationId, isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return this.annotateForViewer(products, userId);
  }

  /** Returns all products for admin (including inactive), ordered by sortOrder. */
  async listAllByAssoc(associationId: string): Promise<SafeProduct[]> {
    const products = await this.productRepo.find({
      where: { associationId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return products.map((p) => this.toSafeProduct(p));
  }

  /**
   * Creates a product for an association.
   * If the payment onboarding is incomplete the product is created but forced inactive.
   * `balance_topup` (Cercle) products require the caller to be a platform global admin,
   * even though the endpoint is otherwise reachable with `MANAGE_PRODUCTS` (D7).
   */
  async create(
    associationId: string,
    dto: CreateProductDto,
    isGlobalAdmin: boolean
  ): Promise<SafeProduct> {
    this.logger.debug(
      `[SHOP] create product: association=${associationId.slice(0, 8)} type=${dto.type} isGlobalAdmin=${isGlobalAdmin}`
    );
    if (dto.type === 'balance_topup' && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup creation by non-global-admin for association=${associationId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        'Only platform global admins may create Cercle balance_topup products'
      );
    }

    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');

    if (
      dto.customAmountMinCents !== undefined &&
      dto.customAmountMaxCents !== undefined &&
      dto.customAmountMinCents > dto.customAmountMaxCents
    ) {
      throw new BadRequestException('customAmountMinCents must be ≤ customAmountMaxCents');
    }

    const { webhookUrl, webhookSecret, deriveVariantKey, ...rest } = dto;

    if (deriveVariantKey && (dto.type !== 'membership' || dto.variantKey !== undefined)) {
      throw new BadRequestException(
        'deriveVariantKey applies to a membership tier sent without a variantKey'
      );
    }

    // Membership tiers derive their granted tag server-side from the association's own
    // slug/mode + this tier's variantKey - the single source of truth (`deriveCotisationTag`),
    // never a client-supplied value, so tag/product data can't drift apart.
    let grantedTagName = rest.grantedTagName ?? null;
    let tagExpiresAt: Date | null = rest.tagExpiresAt ? new Date(rest.tagExpiresAt) : null;
    if (dto.type === 'membership') {
      if (!asso.cotisationMode) {
        throw new BadRequestException('Cotisation must be enabled before adding a tier product');
      }
      if (deriveVariantKey) {
        // The key and its tag are decided under the association's tier lock, at the very end:
        // here only the refusal that needs no lock - a slug leaving no room for any named tier.
        if (variantKeyCap(asso.slug) < 1) {
          throw new BadRequestException(
            'The association slug is too long to name a cotisation tier within the tag length'
          );
        }
      } else {
        await this.assertVariantKeyFree(associationId, dto.variantKey ?? null);
        await assertCotisationStemFree(
          this.productRepo.manager,
          associationId,
          cotisationStem(asso.slug, dto.variantKey ?? null)
        );
        const derived = deriveCotisationTag(
          asso.slug,
          asso.cotisationMode,
          new Date(),
          dto.variantKey ?? null
        );
        grantedTagName = derived.tagName;
        tagExpiresAt = derived.expiresAt;
      }
    }

    // A grid is validated against the association's own tiers, so it is parsed here rather than
    // by a decorator - and a refusal is a price somebody would not have had.
    const { priceMatrix: rawMatrix, ...withoutMatrix } = rest;
    const priceMatrix = await this.parseProductMatrix(associationId, rawMatrix);
    if (touchesMemberPricing(dto)) {
      await this.assertMemberPricing(asso, {
        amountCents: dto.amountCents ?? null,
        amountCentsMember: dto.amountCentsMember ?? null,
        memberPriceTag: dto.memberPriceTag ?? null,
        // A derived key is not known yet and differs from every sibling's by construction, so no
        // sibling is "itself" - `null` here would hide the base tier as a link target.
        variantKey:
          dto.type === 'membership' && !deriveVariantKey ? (dto.variantKey ?? null) : undefined,
      });
    }

    // Payments may be served by an approved parent's account (delegation), so gate on the
    // resolved target's readiness rather than this association's own onboarding flag.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    // What the caller ASKED for, which is what makes the difference between a product deliberately
    // created off sale and one the platform withheld. Only the second is ever released later.
    const wantedActive = dto.isActive ?? true;
    const product = this.productRepo.create({
      ...withoutMatrix,
      priceMatrix,
      currency: 'eur',
      associationId,
      grantedTagName,
      tagExpiresAt,
      // A balance top-up is repeatable by definition and cannot run out - it credits an account on
      // another site. The default `allowRepeatPurchase: false` would cap every user at one recharge
      // for life, and a purchase cap would put a top-up "out of stock".
      ...(dto.type === 'balance_topup'
        ? { allowRepeatPurchase: true, maxPurchasesPerUser: null, maxPurchasesTotal: null }
        : { allowRepeatPurchase: rest.allowRepeatPurchase }),
      webhookUrl: webhookUrl ?? null,
      webhookSecret: webhookSecret ?? null,
      // Product is inactive until payments can be taken (own or delegated account ready).
      isActive: paymentTarget.ready ? wantedActive : false,
      // ... and it remembers that this is why, so `releaseWithheldProducts` can put it on sale the
      // day the account is. `isActive = false` alone could never say it: it is the same value a
      // deliberate withdrawal writes, and a release driven by it would resurrect those too.
      activationWithheld: !paymentTarget.ready && wantedActive,
    });
    if (product.activationWithheld) {
      this.logger.log(
        `[SHOP] product created WITHHELD for association=${associationId.slice(0, 8)}: payments not ready ` +
          `(provider=${paymentTarget.provider} delegated=${paymentTarget.delegated}) - it goes on sale by itself once they are`
      );
    }
    if (deriveVariantKey && asso.cotisationMode) {
      return this.toSafeProduct(
        await this.saveTierWithDerivedKey(product, asso.slug, asso.cotisationMode, dto.name)
      );
    }
    return this.toSafeProduct(await this.productRepo.save(product));
  }

  /**
   * Inserts a new named tier whose key is derived from its label, under the association's tier
   * lock EXCLUSIVE (`lockAssociationTiers`, the retag's): the sibling keys are read and the row
   * inserted in ONE transaction, every read on its manager, so two concurrent creates of the same
   * label get distinct keys (the second waits for the first to commit, then sees its row).
   * Everything that may call another service ran before.
   *
   * The key is free BY CONSTRUCTION, so nothing here refuses it but the exhaustion of its suffixes
   * (409 `TIER_KEY_EXHAUSTED`): unused among the siblings, never year-shaped, colliding with no other
   * association's stem (`stemCollidesElsewhere`, the comparison `assertCotisationStemFree` makes on a
   * typed key), and naming no tag this association still has ACTIVE holders of
   * (`heldTierStems`) - a recreated "Avec alcool" must not silently adopt the holders a deleted
   * one left behind. A manager who typed a label must not meet a refusal about a key they never saw.
   */
  private async saveTierWithDerivedKey(
    product: AssociationProduct,
    slug: string,
    mode: CotisationMode,
    name: string
  ): Promise<AssociationProduct> {
    return this.productRepo.manager.transaction(async (manager) => {
      await lockAssociationTiers(manager, product.associationId);
      const siblings = await manager.find(AssociationProduct, {
        where: { associationId: product.associationId, type: 'membership' },
      });
      const collidesElsewhere = await stemCollidesElsewhere(manager, product.associationId);
      const heldNames = await this.heldTierTagNames(manager, product.associationId, slug);
      let key: string;
      try {
        key = variantKeyFromLabel(
          name,
          siblings.map((p) => p.variantKey ?? null),
          variantKeyCap(slug),
          (candidate) =>
            collidesElsewhere(cotisationStem(slug, candidate)) ||
            heldNames.some((held) =>
              cotisationStemsCollide(`cotisant:${cotisationStem(slug, candidate)}`, held)
            )
        );
      } catch (err) {
        if (!(err instanceof VariantKeySpaceExhaustedError)) throw err;
        this.logger.warn(
          `[COTISATION] no free tier key for association=${product.associationId.slice(0, 8)}: "${err.base}" and every suffix are taken`
        );
        throw new ConflictException({
          code: TIER_KEY_EXHAUSTED,
          message:
            'Every identifier this label could give a tier is already taken - choose another label',
        });
      }
      const derived = deriveCotisationTag(slug, mode, new Date(), key);
      product.variantKey = key;
      product.grantedTagName = derived.tagName;
      product.tagExpiresAt = derived.expiresAt;
      this.logger.log(
        `[COTISATION] derived tier key for association=${product.associationId.slice(0, 8)}: "${key}" (${siblings.length} existing tier(s))`
      );
      return manager.save(AssociationProduct, product);
    });
  }

  /**
   * The ACTIVE tag names this association issued under its cotisation root (`cotisant:<slug>` and
   * `cotisant:<slug>-...`), whatever tier, live or deleted, they belong to. Read inside the derived
   * create's lock, on its `manager`, so a derived key skips a stem whose holders a deleted tier left
   * (`orphanTierTags`) instead of re-adopting them. A typed key (older clients) is not checked
   * against it: that path can still re-adopt (docs/wiki/cotisations.md).
   */
  private async heldTierTagNames(
    manager: EntityManager,
    associationId: string,
    slug: string
  ): Promise<string[]> {
    const root = `cotisant:${slug}`;
    const rows: { tagName: string }[] = await manager.query(
      `SELECT DISTINCT "tagName" FROM user_tags
        WHERE "issuingAssocId" = $1
          AND ("expiresAt" IS NULL OR "expiresAt" > now())
          AND starts_with("tagName", $2)`,
      [associationId, `${root}-`]
    );
    this.logger.debug(
      `[COTISATION] ${rows.length} held tier tag name(s) under ${root}- for a derived key`
    );
    return rows.map((r) => r.tagName);
  }

  /**
   * Updates mutable fields of a product. Ignores webhookSecret if not provided.
   * Updating an existing `balance_topup` (Cercle) product requires the caller to be a
   * platform global admin, even though the endpoint is otherwise reachable with
   * `MANAGE_PRODUCTS` (D7).
   */
  async update(
    associationId: string,
    productId: string,
    dto: UpdateProductDto,
    isGlobalAdmin: boolean
  ): Promise<SafeProduct> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');

    if (product.type === 'balance_topup' && !isGlobalAdmin) {
      this.logger.debug(
        `[CERCLE] rejected balance_topup update by non-global-admin for product=${productId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        'Only platform global admins may modify Cercle balance_topup products'
      );
    }

    const minCents = dto.customAmountMinCents ?? product.customAmountMinCents;
    const maxCents = dto.customAmountMaxCents ?? product.customAmountMaxCents;
    if (
      minCents !== null &&
      maxCents !== null &&
      minCents !== undefined &&
      maxCents !== undefined &&
      minCents > maxCents
    ) {
      throw new BadRequestException('customAmountMinCents must be ≤ customAmountMaxCents');
    }

    // Setting `isActive` by hand is the admin taking ownership of the state: whatever the platform
    // withheld and why stops being true the moment somebody decides for themselves. Putting a
    // product on sale while payments cannot be taken is refused rather than accepted and quietly
    // undone - it would list a product whose every checkout 400s.
    if (dto.isActive !== undefined) {
      if (dto.isActive) {
        const asso = await this.assoRepo.findOne({ where: { id: associationId } });
        if (!asso) throw new NotFoundException('Association not found');
        const paymentTarget = await this.resolvePaymentTargetFor(asso);
        if (!paymentTarget.ready) {
          throw new BadRequestException(
            paymentTarget.delegated
              ? 'The parent association this club delegates payments to has not completed onboarding, so nothing can be put on sale yet.'
              : 'Complete the online-payment onboarding before putting a product on sale.'
          );
        }
      }
      product.activationWithheld = false;
    }

    if (dto.priceMatrix !== undefined) {
      product.priceMatrix = await this.parseProductMatrix(associationId, dto.priceMatrix);
    }

    // `priceMatrix` is resolved above and deliberately kept out of the blanket assign: the DTO
    // holds the RAW document a client sent, and copying it over the parsed one would store a grid
    // nothing validated.
    // A membership product's granted tag and expiry are DERIVED (`deriveCotisationTag`), never
    // typed: they are dropped from the assign here exactly as `create` ignores them, so no edit can
    // store a tag name the association's own tiers do not derive.
    const {
      priceMatrix: _rawMatrix,
      grantedTagName: typedTag,
      tagExpiresAt: typedExpiry,
      ...derivable
    } = dto;
    const assignable =
      product.type === 'membership'
        ? derivable
        : { ...derivable, grantedTagName: typedTag, tagExpiresAt: typedExpiry };
    if (product.type === 'membership' && (typedTag !== undefined || typedExpiry !== undefined)) {
      this.logger.debug(
        `[SHOP] update of membership product=${productId.slice(0, 8)}: typed grantedTagName/tagExpiresAt ignored (derived)`
      );
    }
    const applyEdits = async (target: AssociationProduct, manager: EntityManager) => {
      if (dto.isActive !== undefined) target.activationWithheld = false;
      if (dto.priceMatrix !== undefined) target.priceMatrix = product.priceMatrix;
      Object.assign(target, assignable, { currency: 'eur' });
      if (touchesMemberPricing(dto)) {
        const asso = await manager.findOne(Association, { where: { id: associationId } });
        if (!asso) throw new NotFoundException('Association not found');
        await this.assertMemberPricing(
          asso,
          {
            id: target.id,
            amountCents: target.amountCents,
            amountCentsMember: target.amountCentsMember,
            memberPriceTag: target.memberPriceTag,
            variantKey: target.type === 'membership' ? target.variantKey : undefined,
          },
          manager
        );
      }
      // Same rule as on creation, and it also repairs a top-up product created before it existed:
      // saving the product from /admin/cercle is enough to make it repeatable and unlimited again.
      if (target.type === 'balance_topup') {
        target.allowRepeatPurchase = true;
        target.maxPurchasesPerUser = null;
        target.maxPurchasesTotal = null;
      }
    };
    const retags =
      product.type === 'membership' &&
      dto.variantKey !== undefined &&
      (dto.variantKey ?? null) !== product.variantKey;
    if (!retags) {
      await applyEdits(product, this.productRepo.manager);
      return this.toSafeProduct(await this.productRepo.save(product));
    }

    // A RETAG renames the tier's tag on every holder at once. It holds the association's tier lock
    // EXCLUSIVE (`lockAssociationTiers`) from its first read to its commit: every per-buyer path
    // (checkout, settlement, grant, revoke) holds that lock SHARED before its buyer lock and reads
    // the tiers only after both, so none can derive the OLD tag and write it after the rename. It
    // takes no buyer lock, so it cannot deadlock against them. The product, the sibling links and
    // the tag names are all read INSIDE, after the lock.
    return this.productRepo.manager.transaction(async (manager) => {
      await lockAssociationTiers(manager, associationId);
      this.logger.debug(`[COTISATION] tier retag holds association=${associationId.slice(0, 8)}`);
      const current = await manager.findOne(AssociationProduct, {
        where: { id: productId, associationId },
      });
      if (!current) throw new NotFoundException('Product not found');
      const retagging = await this.planTierRetag(current, dto.variantKey ?? null, manager);
      await applyEdits(current, manager);
      current.grantedTagName = retagging.newTagName;
      current.tagExpiresAt = retagging.newExpiresAt;
      // A sibling's `memberPriceTag` names this tier by its key: re-pointed in the same transaction,
      // or the preferential price of a rise silently stops applying.
      const linkedIds = (await manager.find(AssociationProduct, { where: { associationId } }))
        .filter(
          (p) =>
            p.id !== current.id &&
            p.memberPriceTag &&
            linkedTierKey(p.memberPriceTag, retagging.slug, [retagging.oldVariantKey]) !== undefined
        )
        .map((p) => p.id);
      const saved = await manager.save(AssociationProduct, current);
      if (linkedIds.length > 0) {
        await manager.update(
          AssociationProduct,
          { id: In(linkedIds) },
          { memberPriceTag: retagging.newTagName }
        );
        this.logger.log(
          `[COTISATION] re-pointed ${linkedIds.length} preferential price link(s) to tier ${current.id.slice(0, 8)}`
        );
      }
      await this.assertRetagNameFree(associationId, retagging, manager);
      const result: { affected?: number | null } = await manager
        .createQueryBuilder()
        .update('user_tags')
        .set({ tagName: retagging.newTagName, expiresAt: retagging.newExpiresAt })
        .where('"issuingAssocId" = :assocId AND "tagName" = :oldTag', {
          assocId: associationId,
          oldTag: retagging.oldTagName,
        })
        .execute();
      this.logger.log(
        `[COTISATION] retagged tier ${current.id.slice(0, 8)}: "${retagging.oldTagName}" -> "${retagging.newTagName}" (${result.affected ?? 0} cotisant tag(s) migrated)`
      );
      return this.toSafeProduct(saved);
    });
  }

  /**
   * Refuses (409 `TIER_TAG_NAME_TAKEN`) a retag when a holder of the tier's old tag already holds a
   * row of the NEW name, whoever issued it: the rename would otherwise meet the `(userId, tagName)`
   * unique index, or turn a row another association issued into a duplicate holder. Read under the
   * retag's exclusive association lock, through its `manager`.
   */
  private async assertRetagNameFree(
    associationId: string,
    retagging: { oldTagName: string; newTagName: string },
    manager: EntityManager
  ): Promise<void> {
    const taken: { userId: string }[] = await manager.query(
      `SELECT o."userId" FROM user_tags o
         JOIN user_tags n ON n."userId" = o."userId" AND n."tagName" = $3
        WHERE o."issuingAssocId" = $1 AND o."tagName" = $2
        LIMIT 1`,
      [associationId, retagging.oldTagName, retagging.newTagName]
    );
    if (taken.length === 0) return;
    this.logger.warn(
      `[COTISATION] retag "${retagging.oldTagName}" -> "${retagging.newTagName}" refused: ` +
        `a holder already has a row of the new name`
    );
    throw new ConflictException({
      code: TIER_TAG_NAME_TAKEN,
      message: 'A holder of this tier already holds a tag of the new name',
    });
  }

  /**
   * Prepares a membership tier's move to a different `variantKey`: rejects a collision with a
   * sibling tier and resolves the old/new derived tag names.
   *
   * Retiering exists so an association that outgrew its single base tier can convert the
   * auto-provisioned base product into a named one (WP-COT-11) instead of being stuck with a tier
   * that reports `tier: null` to consumers such as Le Cercle. Because the tag is fully derived,
   * the existing cotisants can be carried over by renaming their tag - nobody loses their
   * cotisation over an admin re-labelling their forfaits.
   */
  private async planTierRetag(
    product: AssociationProduct,
    newVariantKey: string | null,
    manager: EntityManager
  ): Promise<{
    oldTagName: string;
    newTagName: string;
    newExpiresAt: Date | null;
    slug: string;
    oldVariantKey: string | null;
  }> {
    const asso = await manager.findOne(Association, { where: { id: product.associationId } });
    if (!asso?.cotisationMode) {
      throw new BadRequestException('Cotisation must be enabled to change a tier');
    }
    await this.assertVariantKeyFree(product.associationId, newVariantKey, product.id, manager);
    await assertCotisationStemFree(
      manager,
      product.associationId,
      cotisationStem(asso.slug, newVariantKey)
    );

    const now = new Date();
    const oldTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, product.variantKey);
    const newTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, newVariantKey);
    return {
      oldTagName: oldTag.tagName,
      newTagName: newTag.tagName,
      newExpiresAt: newTag.expiresAt,
      slug: asso.slug,
      oldVariantKey: product.variantKey,
    };
  }

  /**
   * Refuses, at SAVE time, member pricing nothing could honour:
   *
   * - `amountCentsMember` must be > 0 and < `amountCents`: a preferential price at or above the
   *   full price is not one, and zero is below what the provider accepts;
   * - `memberPriceTag` must name ANOTHER cotisation tier of the same association (`linkedTierKey`)
   *   - it is read as that tier, whatever academic year the saved string carries.
   *
   * Called only when the request touches one of those columns (`touchesMemberPricing`), so a row
   * written before the rule still saves its other edits.
   */
  private async assertMemberPricing(
    asso: Association,
    candidate: {
      id?: string;
      amountCents: number | null;
      amountCentsMember: number | null;
      memberPriceTag: string | null;
      /** The candidate's own tier key when it is a tier, `undefined` otherwise. */
      variantKey: string | null | undefined;
    },
    manager: EntityManager = this.productRepo.manager
  ): Promise<void> {
    const member = candidate.amountCentsMember;
    if (
      member != null &&
      (member <= 0 || (candidate.amountCents !== null && member >= candidate.amountCents))
    ) {
      this.logger.debug(
        `[SHOP] member price refused: association=${asso.id.slice(0, 8)} member=${member} full=${candidate.amountCents}`
      );
      throw new BadRequestException(
        'The preferential price must be more than zero and less than the full price'
      );
    }
    if (!candidate.memberPriceTag) return;
    const tiers = asso.cotisationMode
      ? await manager.find(AssociationProduct, {
          where: { associationId: asso.id, type: 'membership' },
          select: { id: true, variantKey: true },
        })
      : [];
    const keys = tiers
      .filter((t) => t.id !== candidate.id)
      .map((t) => t.variantKey)
      .filter((k) => candidate.variantKey === undefined || k !== candidate.variantKey);
    if (linkedTierKey(candidate.memberPriceTag, asso.slug, keys) === undefined) {
      this.logger.debug(
        `[SHOP] memberPriceTag refused: association=${asso.id.slice(0, 8)} names no other tier`
      );
      throw new BadRequestException({
        code: MEMBER_PRICE_TAG_NOT_A_TIER,
        message: 'memberPriceTag must name another cotisation tier of this association',
      });
    }
  }

  /**
   * Throws when another membership product of the association already claims `variantKey`.
   * Two tiers sharing a key would derive the same tag, making the forfait a coin flip: the XOR
   * revoke, the roster label and `cotisant-status` would each pick whichever row they saw first.
   *
   * Also refuses a key shaped like an academic year (`2024-2025`, or ending `-2024-2025`): its tag
   * would be the very name of a `dated` tag of another tier (`cotisant:<slug>-2024-2025` is the base
   * tier's dated tag), so the tier reads (`linkedTierKey`, `orphanTierTags`) could not tell the two
   * apart - and once such a tier is deleted, its holders' tag would read as the base tier's, not as
   * an orphan.
   */
  private async assertVariantKeyFree(
    associationId: string,
    variantKey: string | null,
    exceptProductId?: string,
    manager: EntityManager = this.productRepo.manager
  ): Promise<void> {
    if (variantKey !== null && YEAR_SHAPED_VARIANT_KEY.test(variantKey)) {
      this.logger.debug(
        `[COTISATION] tier key "${variantKey}" refused: shaped like an academic year`
      );
      throw new BadRequestException({
        code: TIER_KEY_YEAR_SHAPED,
        message: `Tier "${variantKey}" cannot be named like an academic year (YYYY-YYYY)`,
      });
    }
    const siblings = await manager.find(AssociationProduct, {
      where: { associationId, type: 'membership' },
    });
    const clash = siblings.find(
      (p) => p.id !== exceptProductId && (p.variantKey ?? null) === variantKey
    );
    if (clash) {
      throw new BadRequestException(
        variantKey
          ? `Tier "${variantKey}" already exists for this association`
          : 'This association already has a base tier'
      );
    }
  }

  /**
   * Removes a product from the association's boutique.
   *
   * Refuses to delete the association's LAST membership product while cotisations are enabled:
   * with no tier left, `deriveCotisationTag` still answers but nothing grants or recognizes the
   * tag, so the whole cotisation silently stops working. Dropping the now-redundant base tier of
   * a multi-tier association is exactly what this DOES allow (WP-COT-11) - once nobody holds it.
   *
   * Refuses, `409 TIER_HAS_HOLDERS` with `holderCount`, to delete a tier people hold ACTIVE
   * (`UserTagService.countActiveTierHolders`): every tier read derives a holder's tier from the
   * products that exist, so a deleted tier's holders would keep a tag naming nothing. The count and
   * the delete run under the association's tier lock EXCLUSIVE (`lockAssociationTiers`, the retag's
   * lock): it waits for every per-buyer transaction in flight (a settlement, a grant) and holds the
   * next ones back until it commits, so no grant of the tier lands between the count and the delete,
   * and no new order of locks is introduced. Holders are counted on the rows THIS association issued
   * only - another association's row, or a row no association issued, is held for nobody here and
   * out of this manager's reach - and whether or not cotisations are switched on. It also refuses
   * `409 TIER_CHECKOUT_OPEN` while an attempt of the tier may still be paid
   * (`assertNoOpenTierCheckout`), which would otherwise land as `paid_not_granted`.
   */
  async delete(associationId: string, productId: string): Promise<void> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 'membership') {
      await this.productRepo.remove(product);
      return;
    }
    await this.productRepo.manager.transaction(async (manager) => {
      await lockAssociationTiers(manager, associationId);
      this.logger.debug(`[COTISATION] tier delete holds association=${associationId.slice(0, 8)}`);
      const current = await manager.findOne(AssociationProduct, {
        where: { id: productId, associationId },
      });
      if (!current) throw new NotFoundException('Product not found');
      const asso = await manager.findOne(Association, { where: { id: associationId } });
      if (!asso) throw new NotFoundException('Association not found');
      if (asso.cotisationMode) {
        const remaining = await manager.count(AssociationProduct, {
          where: { associationId, type: 'membership' },
        });
        if (remaining <= 1) {
          throw new BadRequestException(
            'Cannot delete the last cotisation tier while cotisations are enabled'
          );
        }
      }
      // Asked with cotisations switched off too: the tags stay held while the mode is off, and
      // switching it back on must not find them orphaned. The stem does not depend on the mode.
      const holderCount = await this.userTagService.countActiveTierHolders(
        associationId,
        asso.slug,
        current.variantKey,
        manager
      );
      if (holderCount > 0) {
        this.logger.log(
          `[COTISATION] refused (${TIER_HAS_HOLDERS}): tier ${current.id.slice(0, 8)} of ` +
            `association=${associationId.slice(0, 8)} has ${holderCount} active holder(s)`
        );
        throw new ConflictException({
          code: TIER_HAS_HOLDERS,
          message:
            'People still hold this cotisation tier; a member manager must move them to another tier first',
          holderCount,
        });
      }
      await this.assertNoOpenTierCheckout(current.id, manager);
      await this.assertNoOpenTierFormPayment(associationId, current.variantKey, manager);
      await manager.remove(current);
      // `remove` clears the entity's id, so the log names the one asked for.
      this.logger.log(
        `[COTISATION] tier ${productId.slice(0, 8)} of association=${associationId.slice(0, 8)} deleted`
      );
    });
  }

  /**
   * Refuses `409 TIER_CHECKOUT_OPEN` while an attempt of tier `productId` may still be paid: open,
   * and not past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`, after which every other path treats it
   * as closed too. Deleting the tier then would turn that payment into `paid_not_granted`, a refund
   * owed. Asked under the association's exclusive tier lock, which a checkout opening holds shared
   * while it writes its attempt, so an attempt being opened is committed (and seen) or not begun.
   */
  private async assertNoOpenTierCheckout(productId: string, manager: EntityManager): Promise<void> {
    const rows: { n: number }[] = await manager.query(
      `SELECT count(*)::int AS n FROM product_checkouts
        WHERE "productId" = $1 AND status = 'open'
          AND "expiresAt" > now() - make_interval(secs => $2)`,
      [productId, CHECKOUT_EXPIRY_MARGIN_MS / 1000]
    );
    const open = rows[0]?.n ?? 0;
    if (open === 0) return;
    this.logger.log(
      `[COTISATION] refused (${TIER_CHECKOUT_OPEN}): tier ${productId.slice(0, 8)} has ${open} payment(s) in progress`
    );
    throw new ConflictException({
      code: TIER_CHECKOUT_OPEN,
      message:
        'A payment for this cotisation tier is in progress; take it off sale, then try again once it is settled',
    });
  }

  /**
   * `assertNoOpenTierCheckout` for the OTHER way a tier is paid for: an answer to one of the
   * association's forms that grants tier `variantKey`, still waiting for its money - online and
   * within its hold (`PENDING_HOLD_CUTOFF_SQL`, the forms' own definition of a live payment), or
   * waiting for cash a manager will validate. Landing after the delete, its grant would name a tier
   * that no longer exists and be recorded `paid_not_granted`, a refund owed. Same `409
   * TIER_CHECKOUT_OPEN`. A form submit takes no tier lock, so an answer opened in the instant of the
   * delete is not seen: it lands `paid_not_granted` and the hourly report names it.
   */
  private async assertNoOpenTierFormPayment(
    associationId: string,
    variantKey: string | null,
    manager: EntityManager
  ): Promise<void> {
    const rows: { n: number }[] = await manager.query(
      `SELECT count(*)::int AS n FROM submissions s JOIN forms f ON f.id = s."formId"
        WHERE f."associationId" = $1 AND f."grantsCotisation"
          AND f."cotisationVariantKey" IS NOT DISTINCT FROM $2
          AND (s."paymentStatus" = 'pending_cash'
               OR (s."paymentStatus" = 'pending' AND s."paymentRequestedAt" > ${PENDING_HOLD_CUTOFF_SQL}))`,
      [associationId, variantKey]
    );
    const open = rows[0]?.n ?? 0;
    if (open === 0) return;
    this.logger.log(
      `[COTISATION] refused (${TIER_CHECKOUT_OPEN}): tier ${variantKey ?? 'base'} of ` +
        `association=${associationId.slice(0, 8)} has ${open} form payment(s) in progress`
    );
    throw new ConflictException({
      code: TIER_CHECKOUT_OPEN,
      message:
        'A payment for this cotisation tier is in progress; take it off sale, then try again once it is settled',
    });
  }

  /**
   * Uploads a decorative icon for a product (e.g. a partner brand's logo), replacing any existing
   * one. Same validation and media-service delegation as `AssociationsService.setLogoFromUpload`.
   */
  async setProductIcon(
    associationId: string,
    productId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
    authorization: string | undefined
  ): Promise<SafeProduct> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');
    if (!authorization?.startsWith('Bearer ')) {
      throw new BadRequestException('Missing authorization header');
    }
    if (file.size > ICON_MAX_BYTES) {
      throw new BadRequestException(`Icon must be at most ${ICON_MAX_BYTES} bytes`);
    }
    if (!ALLOWED_ICON_MIMES.has(file.mimetype?.toLowerCase() ?? '')) {
      throw new BadRequestException('Icon must be JPEG, PNG, or WebP');
    }

    const oldMediaId = product.iconMediaId;
    const mediaId = await this.associationsService.uploadPublicImage(file, authorization);
    product.iconMediaId = mediaId;
    product.iconUrl = `/api/media/public/${mediaId}?v=${Date.now()}`;
    const saved = await this.productRepo.save(product);

    if (oldMediaId && oldMediaId !== mediaId) {
      await this.associationsService.deleteMediaBestEffort(oldMediaId, authorization);
    }
    return this.toSafeProduct(saved);
  }

  /** Removes a product's decorative icon, reverting it to the type-based fallback. */
  async clearProductIcon(
    associationId: string,
    productId: string,
    authorization: string | undefined
  ): Promise<SafeProduct> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');
    const oldMediaId = product.iconMediaId;
    product.iconMediaId = null;
    product.iconUrl = null;
    const saved = await this.productRepo.save(product);

    if (oldMediaId && authorization?.startsWith('Bearer ')) {
      await this.associationsService.deleteMediaBestEffort(oldMediaId, authorization);
    }
    return this.toSafeProduct(saved);
  }

  // ── Cotisation config ─────────────────────────────────────────────────────

  /**
   * Upserts the canonical `membership` product(s) for an association whose cotisations are
   * enabled (D1, WP-COT-6): derives each tier's `grantedTagName`/`tagExpiresAt` from
   * `deriveCotisationTag` (keyed on that product's own `variantKey`) so every tier's granted tag
   * always matches the association's current slug/mode. Called after `PATCH /associations/:id`
   * when `cotisationEnabled` is true.
   *
   * On first activation (no membership product yet) this creates the single base tier
   * (`variantKey: null`). Once tiers exist, ALL of them are resynced - not just one - since a
   * multi-tier association (e.g. Le Cercle) has several. Each product's `name`/`amountCents`/
   * `variantKey` are preserved across calls, so this never overwrites admin edits made through
   * the regular product endpoints - it only ever (re)synchronizes the derived tag fields.
   */
  async provisionCotisationProduct(asso: Association): Promise<AssociationProduct> {
    this.logger.debug(
      `[COTISATION] provisioning canonical product(s): association=${asso.id.slice(0, 8)} mode=${asso.cotisationMode}`
    );
    if (!asso.cotisationMode) {
      throw new BadRequestException('cotisationMode is required when cotisationEnabled is true');
    }
    const cotisationMode = asso.cotisationMode;

    const existing = await this.productRepo.find({
      where: { associationId: asso.id, type: 'membership' },
    });

    if (existing.length === 0) {
      const { tagName, expiresAt } = deriveCotisationTag(asso.slug, cotisationMode);
      this.logger.log(
        `[COTISATION] creating canonical membership product for association=${asso.id.slice(0, 8)} tag=${tagName}`
      );
      const ready = (await this.resolvePaymentTargetFor(asso)).ready;
      const product = this.productRepo.create({
        associationId: asso.id,
        name: 'Cotisation',
        currency: 'eur',
        type: 'membership',
        grantedTagName: tagName,
        tagExpiresAt: expiresAt,
        // Active once payments can be taken - own account or an approved parent's (delegation).
        isActive: ready,
        // The cotisation is always WANTED on sale, so when payments are not ready it is withheld
        // exactly like `create` withholds a product, and the same releases put it on sale.
        activationWithheld: !ready,
      });
      if (!ready) {
        this.logger.log(
          `[COTISATION] canonical product created WITHHELD for association=${asso.id.slice(0, 8)}: payments not ready`
        );
      }
      return this.productRepo.save(product);
    }

    this.logger.log(
      `[COTISATION] resyncing ${existing.length} membership tier(s) for association=${asso.id.slice(0, 8)}`
    );
    const resynced = await Promise.all(
      existing.map((product) => {
        const { tagName, expiresAt } = deriveCotisationTag(
          asso.slug,
          cotisationMode,
          new Date(),
          product.variantKey
        );
        product.grantedTagName = tagName;
        product.tagExpiresAt = expiresAt;
        return this.productRepo.save(product);
      })
    );
    return resynced.find((p) => p.variantKey === null) ?? resynced[0];
  }

  // ── Checkout ───────────────────────────────────────────────────────

  /**
   * Opens ONE checkout attempt for a product: a `product_checkouts` row first, then the Lydia
   * request it names (order_ref `product:<productId>:<checkoutId>`, unique per attempt).
   *
   * Before anything is issued, the buyer's previous OPEN attempt of the same product is settled at
   * the provider (`settlePreviousOpenAttempt`): cancelled, or read paid / closed - so a request the
   * buyer already paid is recorded instead of charged a second time, and "already purchased" is
   * then decided by Canari from durable state (`assertCanPurchase`), before any request/do. A
   * double click loses on the partial unique index `product_checkouts_one_open` and is answered
   * `CHECKOUT_IN_PROGRESS`. The amount is resolved HERE and stored on the row: it is the only amount
   * a settlement records.
   */
  async createCheckoutSession(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number,
    callbackUrls?: { successUrl?: string; cancelUrl?: string },
    payerEmail?: string
  ): Promise<{ checkoutUrl: string; amountCents: number; currency: string; checkoutId: string }> {
    await assertReviewerReachesAssociation(
      this.productRepo.manager,
      userId,
      associationId,
      'product checkout'
    );
    for (const id of await this.productsToSettleBefore(associationId, productId)) {
      await this.settlePreviousOpenAttempt(id, userId);
    }

    // The rank, the amount and the attempt row are decided under the buyer's tier lock, so a
    // settlement of a sibling tier cannot commit between the rank this checkout reads and the row
    // it writes: whichever takes the lock second reads the other's commit.
    // Everything that calls another service is decided BEFORE the lock (`preparePurchase`).
    const prepared = await this.preparePurchase(associationId, productId, userId);
    let opened: { resolved: ResolvedPurchase; checkout: ProductCheckout };
    try {
      opened = await this.checkoutRepo.manager.transaction(async (manager) => {
        await this.lockBuyerTiers(manager, associationId, userId);
        const resolved = await this.decidePurchase(prepared, userId, customAmountCents, manager);
        const checkout = await manager.save(
          ProductCheckout,
          this.checkoutRepo.create({
            productId: resolved.product.id,
            userId,
            associationId: resolved.product.associationId,
            paymentAssociationId: resolved.paymentTarget.targetAssociationId,
            vendorToken: resolved.vendorToken,
            amountCents: resolved.amountCents,
            currency: resolved.product.currency,
            productName: resolved.product.name,
            requestUuid: null,
            requestId: null,
            status: 'open',
            expiresAt: new Date(Date.now() + PRODUCT_REQUEST_LIFETIME_SECONDS * 1000),
            settledAt: null,
            heldTierProductId: resolved.heldTierProductId,
            purchaseRecordId: null,
          })
        );
        return { resolved, checkout };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw this.checkoutInProgress(
          productId,
          userId,
          'another attempt was opened at the same time'
        );
      }
      throw err;
    }
    const { checkout } = opened;
    const { product, amountCents, paymentTarget, vendorToken } = opened.resolved;
    this.logger.log(
      `[SHOP] checkout ${checkout.id.slice(0, 8)} opened: product=${product.id.slice(0, 8)} ` +
        `user=${userId.slice(0, 8)} amount=${amountCents} payTo=${paymentTarget.targetAssociationId.slice(0, 8)}`
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost';

    const successUrl = resolveCheckoutCallbackUrl(
      callbackUrls?.successUrl,
      `${frontendUrl}/shop?purchase_success=1&productId=${product.id}`,
      frontendUrl
    );
    const cancelUrl = resolveCheckoutCallbackUrl(
      callbackUrls?.cancelUrl,
      `${frontendUrl}/shop?purchase_cancel=1&productId=${product.id}`,
      frontendUrl
    );

    const returnKey = {
      checkoutId: checkout.id,
      associationId: product.associationId,
      productId: product.id,
    };
    let resp;
    try {
      resp = await firstValueFrom(
        this.httpService.post<{ ok: boolean; url: string; id: string; requestId?: string | null }>(
          coreUrl('payments/create-checkout-session'),
          {
            lineItems: [
              {
                price_data: {
                  currency: product.currency,
                  product_data: { name: product.name },
                  unit_amount: amountCents,
                },
                quantity: 1,
              },
            ],
            successUrl: withCheckoutReturnKey(successUrl, returnKey),
            cancelUrl: withCheckoutReturnKey(cancelUrl, returnKey),
            metadata: { productId: product.id, userId, checkoutId: checkout.id },
            connectAccountId: vendorToken,
            // Lydia's order_ref: unique per ATTEMPT, since Lydia refuses one it has seen (error 3).
            idempotencyKey: productOrderRef(product.id, checkout.id),
            payerEmail,
            expireAfterSeconds: PRODUCT_REQUEST_LIFETIME_SECONDS,
          },
          internalCoreRequestConfig()
        )
      );
    } catch (err) {
      if (coreRefusedRequest(err)) {
        // An ANSWER: core refused the request, so nothing was issued and nothing is payable.
        await this.releaseUnissuedCheckout(checkout.id);
        // Lydia's error 5 / 2701: the Business is not validated or blocked. The holder of the
        // vendor token stops being ready, whatever had marked it ready (lydia-readiness.ts).
        const cause = lydiaReadinessRefusal(err);
        if (cause) {
          await this.associationsService.revertLydiaReadinessAfterRefusal(vendorToken, cause, {
            path: 'shop',
            id: checkout.id,
          });
        }
      } else {
        // LOST, not answered (a timeout, a 5xx): Lydia may hold a request all the same, so the
        // attempt stays open and is read by its order_ref - at the buyer's next attempt, return or
        // the confirm callback - rather than closed on a guess.
        this.logger.error(
          `[SHOP] checkout ${checkout.id.slice(0, 8)}: request/do was lost, not answered - left open, ` +
            `to be read at Lydia by its order_ref`
        );
      }
      throw mapCorePaymentError(err, this.logger, 'SHOP');
    }

    const requestUuid = typeof resp.data?.id === 'string' ? resp.data.id : null;
    const requestId = typeof resp.data?.requestId === 'string' ? resp.data.requestId : null;
    if (!resp.data?.url || !requestUuid) {
      // Core answered 2xx, so Lydia very probably holds the request: the attempt stays open and is
      // read by its order_ref, never closed as if nothing had been issued.
      this.logger.error(
        `[SHOP] checkout ${checkout.id.slice(0, 8)}: the payment service answered without a ` +
          `${resp.data?.url ? 'request id' : 'checkout URL'} - left open, to be read at Lydia by its order_ref`
      );
      throw new BadRequestException('Payment service did not return a checkout URL');
    }

    // Named columns: the request ids are the only thing this write may change.
    await this.checkoutRepo.update({ id: checkout.id }, { requestUuid, requestId });
    this.logger.log(
      `[SHOP] checkout ${checkout.id.slice(0, 8)} issued: request ${requestId ?? 'without a numeric id'} ` +
        `product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)}`
    );
    return {
      checkoutUrl: resp.data.url,
      amountCents,
      currency: product.currency,
      checkoutId: checkout.id,
    };
  }

  /**
   * The products whose OPEN attempts are settled before a checkout of `productId` opens: the product
   * itself and, for a cotisation tier, every sibling tier of its association - one tier only can be
   * held, so a buyer must never hold payable requests for two of them. Siblings first, so a sibling
   * found already paid is recorded before this checkout ranks against the tier it grants.
   */
  private async productsToSettleBefore(
    associationId: string,
    productId: string
  ): Promise<string[]> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (product?.type !== 'membership') return [productId];
    const tiers = await this.productRepo.find({
      where: { associationId, type: 'membership' },
      select: { id: true },
    });
    const siblings = tiers.map((t) => t.id).filter((id) => id !== productId);
    this.logger.debug(
      `[SHOP] settling open attempts of ${siblings.length} sibling tier(s) before product=${productId.slice(0, 8)}`
    );
    return [...new Set(siblings), productId];
  }

  /**
   * Settles, at the provider, the buyer's OPEN attempt of this product before a new one is issued,
   * so no buyer ever holds two payable requests for one product. Returns once that attempt is no
   * longer open: cancelled at Lydia, or read closed / declined / not found / PAID (a paid one is
   * recorded here, as the callback would, and the purchase rules that follow then see it). Throws
   * `CHECKOUT_IN_PROGRESS` while the attempt's request is being issued, and `PREVIOUS_CHECKOUT_OPEN`
   * while its fate cannot be established - refusing is the one answer that cannot double-charge.
   *
   * That refusal ENDS: past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS` the request was sent an
   * `expire_time` that has run out, so an attempt still unproven (the read or the cancel fails, Lydia
   * still answers open) is closed `expired` at ERROR and the buyer may
   * retry. A payment Lydia took before then is still recorded by its confirm callback, which finds
   * the attempt by id whatever its status.
   *
   * Lydia's cancel answers error 2 (`already-settled`) for a request already processed - measured on
   * cancelled and expired ones, very probably the same for a paid one - so that answer is never read
   * as "nobody paid": `request/state` tells paid from closed.
   */
  private async settlePreviousOpenAttempt(productId: string, userId: string): Promise<void> {
    const open = await this.checkoutRepo.findOne({
      where: { productId, userId, status: 'open' },
    });
    if (!open) {
      this.logger.debug(
        `[SHOP] no open attempt to settle: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)}`
      );
      return;
    }
    if (this.isBeingIssued(open)) {
      throw this.checkoutInProgress(
        productId,
        userId,
        `attempt ${open.id.slice(0, 8)} is being issued`
      );
    }
    let unproven: string;
    try {
      if (open.requestId && (await this.cancelRequestAtLydia(open)) === 'cancelled') {
        this.logger.log(
          `[SHOP] checkout ${open.id.slice(0, 8)}: request ${open.requestId} cancelled`
        );
        await this.closeCheckout(open, 'cancelled');
        return;
      }
      const status = await this.readAndApplyRequestState(open);
      if (status !== 'open') return;
      unproven = 'the request is still open at the provider';
    } catch (err: unknown) {
      unproven = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= open.expiresAt.getTime() + CHECKOUT_EXPIRY_MARGIN_MS) {
      await this.expireUnprovenCheckout(open, unproven);
      return;
    }
    throw this.previousCheckoutOpen(open.id, unproven);
  }

  /**
   * Asks core to cancel the attempt's request at Lydia (`payments/cancel-request`, by its numeric
   * request id, which the caller has checked is stored). `cancelled`, or `already-settled` when Lydia
   * had processed it already - paid, cancelled or expired, which only `request/state` tells apart.
   * Any other answer, or a failed call, THROWS: the request may still be payable.
   */
  private async cancelRequestAtLydia(
    row: ProductCheckout
  ): Promise<'cancelled' | 'already-settled'> {
    const { data } = await firstValueFrom(
      this.httpService.post<{ outcome?: string }>(
        coreUrl('payments/cancel-request'),
        { requestId: row.requestId, connectAccountId: row.vendorToken },
        internalCoreRequestConfig()
      )
    );
    if (data?.outcome === 'cancelled' || data?.outcome === 'already-settled') return data.outcome;
    throw new Error(`unexpected cancel outcome ${JSON.stringify(data?.outcome)}`);
  }

  /**
   * An attempt whose request Lydia VERIFIABLY reports still `open` past the expire_time Canari sent
   * it (the reconciliation sweep): cancelled AT LYDIA first, through the cancel the buyer's next
   * attempt makes, so no payment can land on a request Canari has closed; then closed `cancelled`.
   * - `already-settled`: Lydia processed it between the read and the cancel. The attempt stays
   *   `open` and this answers `open`, so the caller reads it once more (the sweep does, at once).
   * - A cancel Lydia REFUSED with a code measured FINAL (`refusalsFinal.cancel`, empty until
   *   a sandbox measurement fills it): closed `expired` at ERROR (`expireUnprovenCheckout`). The
   *   request may then still be payable at Lydia; a payment on it is recorded only if its confirm
   *   callback arrives, over the closed attempt, at ERROR. Any other refusal - and core answering
   *   about itself, 401/403 or its 503 - THROWS like a cancel with no answer: retried, never closed.
   * - No numeric request id (its request/do answer was lost): the cancel cannot name it, closed
   *   `expired` at ERROR the same way.
   * - A cancel that got NO answer (no response, a timeout, a 5xx) THROWS and closes nothing: the
   *   request may still be payable. Answers the status the row now has.
   */
  async cancelStillOpenCheckout(row: ProductCheckout, why: string): Promise<ProductCheckoutStatus> {
    if (!row.requestId) {
      return this.expireUnprovenCheckout(row, `${why}; no request id to cancel it at Lydia with`);
    }
    let outcome: 'cancelled' | 'already-settled';
    try {
      outcome = await this.cancelRequestAtLydia(row);
    } catch (err: unknown) {
      const failure = classifyCoreCallFailure(err);
      if (failure.kind !== 'refused' || !this.refusalsFinal.cancel.has(failure.providerCode)) {
        throw err;
      }
      return this.expireUnprovenCheckout(
        row,
        `${why}; its cancel at Lydia was refused for good (error ${failure.providerCode})`
      );
    }
    if (outcome === 'already-settled') {
      this.logger.warn(
        `[SHOP] checkout ${row.id.slice(0, 8)}: request ${row.requestId} was processed at Lydia ` +
          `before its cancel (${why}) - left open for one more read`
      );
      return row.status;
    }
    this.logger.log(
      `[SHOP] checkout ${row.id.slice(0, 8)}: request ${row.requestId} cancelled at Lydia (${why})`
    );
    return this.closeCheckout(row, 'cancelled');
  }

  /**
   * Whether an open attempt naming no request is still inside the call that issues it: the issuing
   * call to core gives up after 120 s, and `CHECKOUT_ISSUE_WINDOW_MS` covers it. Reading such an
   * attempt at Lydia would race the request/do that is creating it.
   */
  private isBeingIssued(row: ProductCheckout): boolean {
    return (
      !row.requestUuid &&
      !row.requestId &&
      Date.now() < row.createdAt.getTime() + CHECKOUT_ISSUE_WINDOW_MS
    );
  }

  /**
   * The payer's return (`checkout_id` on the shop page, after Lydia's success OR fail URL): asks the
   * provider about the attempt's OWN request and records it if paid, then answers where it stands.
   * Nothing comes from the client but the attempt id - which must be the CALLER's attempt of this
   * product of this association, or it is not found - and the payment is Lydia's answer about the
   * request the row names, read server to server. Only an `open` attempt is asked about: every other
   * status was either recorded from Lydia's own answer or names no request. A failed read is logged
   * at WARN and answered with the row unchanged: this is a read the payer repeats.
   */
  async confirmCheckout(
    associationId: string,
    productId: string,
    checkoutId: string,
    userId: string
  ): Promise<{ checkoutId: string; productId: string; status: ProductCheckoutStatus }> {
    const row = await this.checkoutRepo.findOne({ where: { id: checkoutId } });
    if (
      !row ||
      row.userId !== userId ||
      row.productId !== productId ||
      row.associationId !== associationId
    ) {
      this.logger.warn(
        `[SHOP] confirm refused: checkout ${checkoutId.slice(0, 8)} is ${row ? "not this caller's attempt of this product" : 'unknown'}`
      );
      throw new NotFoundException('Checkout not found');
    }
    let status = row.status;
    if (status !== 'open') {
      this.logger.debug(`[SHOP] confirm ${row.id.slice(0, 8)}: already ${status}, nothing to ask`);
    } else if (this.isBeingIssued(row)) {
      this.logger.debug(`[SHOP] confirm ${row.id.slice(0, 8)}: its request is being issued`);
    } else {
      try {
        status = await this.readAndApplyRequestState(row);
      } catch (err: unknown) {
        this.logger.warn(
          `[SHOP] confirm ${row.id.slice(0, 8)}: could not read its request: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return { checkoutId: row.id, productId: row.productId, status };
  }

  /**
   * Reads the attempt's request at Lydia (`payments/request-state`) and writes what it says
   * (`applyRequestState`). The request is named by the row's own uuid, or - for an attempt whose
   * issuing call never answered one - by its order_ref (`productCheckoutLookup`). A failed read
   * throws. The read goes to the Business the request was issued to (the row's `vendorToken`
   * snapshot).
   */
  private async readAndApplyRequestState(row: ProductCheckout): Promise<ProductCheckoutStatus> {
    const lookup = productCheckoutLookup(row);
    const { data } = await firstValueFrom(
      this.httpService.post<{ state?: string; raw?: string }>(
        coreUrl('payments/request-state'),
        { ...lookup, connectAccountId: row.vendorToken },
        internalCoreRequestConfig()
      )
    );
    const by = 'sessionId' in lookup ? 'uuid' : 'order_ref';
    this.logger.debug(`[SHOP] checkout ${row.id.slice(0, 8)}: read by ${by} -> ${data?.state}`);
    return this.applyRequestState(row, data?.state, data?.raw);
  }

  /**
   * Writes what Lydia said about the attempt's request - the ONE mapping of a state onto an attempt,
   * shared by the payer's return, the confirm callback and the reconciliation sweep (which calls it
   * only with an answer whose signature it verified). `paid` is settled (`settlePaidCheckout`, the
   * one writer of `paid`), `declined` (state 5) and `cancelled-or-expired` (state 6: `expired` past
   * the row's `expiresAt`, `cancelled` before it - the state alone cannot tell them apart) close the
   * row, `not-found` on an order_ref lookup (no request carries it: request/do never reached Lydia)
   * closes it `cancelled`, `open` and `unknown` change nothing. Returns the status the row now has,
   * as far as this call knows. `raw` is the provider's code, for the log only.
   */
  async applyRequestState(
    row: ProductCheckout,
    wireState: unknown,
    raw?: string
  ): Promise<ProductCheckoutStatus> {
    const lookup = productCheckoutLookup(row);
    // `not-found` is not a request state but the answer of an order_ref LOOKUP that matched no
    // request: request/do never reached Lydia. Read before the one typed mapping of the states.
    if (wireState === 'not-found' && 'orderRef' in lookup) {
      this.logger.warn(
        `[SHOP] checkout ${row.id.slice(0, 8)}: Lydia holds no request with order_ref ${lookup.orderRef} - never issued, closed cancelled`
      );
      return this.closeCheckout(row, 'cancelled');
    }
    const state = toRequestState(wireState);
    if (state === 'paid') {
      this.logger.log(`[SHOP] checkout ${row.id.slice(0, 8)}: request is PAID at the provider`);
      await this.settlePaidCheckout(row.id);
      return 'paid';
    }
    if (state === 'declined') {
      return this.closeCheckout(row, 'declined');
    }
    if (state === 'cancelled-or-expired') {
      return this.closeCheckout(
        row,
        Date.now() >= row.expiresAt.getTime() ? 'expired' : 'cancelled'
      );
    }
    if (state === 'open') {
      this.logger.debug(`[SHOP] checkout ${row.id.slice(0, 8)}: request still open`);
      return row.status;
    }
    this.logger.warn(
      `[SHOP] checkout ${row.id.slice(0, 8)}: request in a state nothing here reads (${raw ?? JSON.stringify(wireState)}) - left ${row.status}`
    );
    return row.status;
  }

  /**
   * Closes an attempt whose request has ENDED (past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`, which
   * the CALLER has checked) and that nothing proved paid - `unproven` says why, for the log. Closed
   * as `expired`, at ERROR, so it stops blocking its buyer's retry and is never asked about again.
   * Nothing is lost by it: a payment taken before the request expired is still recorded by its
   * confirm callback, which asks even of a closed attempt (`handlePurchaseCompleted` ->
   * `settlePaidCheckout`). Shared by the buyer's next attempt (`settlePreviousOpenAttempt`) and the
   * reconciliation sweep, which closes an attempt whose read ANSWERED something it cannot act on.
   * Conditional on `open` (`closeCheckout`): a `paid` written meanwhile stays, and is answered.
   */
  async expireUnprovenCheckout(
    row: ProductCheckout,
    unproven: string
  ): Promise<ProductCheckoutStatus> {
    const status = await this.closeCheckout(row, 'expired');
    if (status === 'expired') {
      this.logger.error(
        `[SHOP] checkout ${row.id.slice(0, 8)} is past its expire_time and still unproven ` +
          `(${unproven}) - closed as expired so its buyer may retry; a payment taken before it ` +
          `expired is still recorded by its confirm callback`
      );
    }
    return status;
  }

  /**
   * Moves an OPEN attempt to a closed status, and answers the status the row now holds.
   * Conditional on `status = 'open'`, so it can never overwrite a `paid` written meanwhile by the
   * other path (the callback, or another return read) - which is then re-read and answered.
   */
  private async closeCheckout(
    row: ProductCheckout,
    status: Exclude<ProductCheckoutStatus, 'open' | 'paid'>
  ): Promise<ProductCheckoutStatus> {
    const { affected } = await this.checkoutRepo.update(
      { id: row.id, status: 'open' },
      { status, settledAt: new Date() }
    );
    if (affected) {
      this.logger.log(`[SHOP] checkout ${row.id.slice(0, 8)} closed as ${status}`);
      return status;
    }
    const now = await this.checkoutRepo.findOne({ where: { id: row.id } });
    this.logger.log(
      `[SHOP] checkout ${row.id.slice(0, 8)} not closed as ${status}: it is already ${now?.status ?? 'gone'}`
    );
    return now?.status ?? status;
  }

  /**
   * An attempt core REFUSED to issue (a 4xx answer): nothing is payable, so it stops blocking a
   * retry. Never called on a lost call, after which Lydia may hold the request all the same.
   */
  private async releaseUnissuedCheckout(checkoutId: string): Promise<void> {
    const { affected } = await this.checkoutRepo.update(
      { id: checkoutId, status: 'open' },
      { status: 'cancelled', settledAt: new Date() }
    );
    this.logger.warn(
      `[SHOP] checkout ${checkoutId.slice(0, 8)} ${affected ? 'released: the request was refused, none was issued' : 'not released: no longer open'}`
    );
  }

  /**
   * Decides at settlement whether a paid cotisation tier is granted, on what the checkout OPENING
   * decided and never on a price read now (user, 2026-10-27; migration 112). The opening ranked the
   * tier against the tier the buyer held then and froze that tier's product id on the row
   * (`heldTierProductId`), so a price an admin edits between the opening and the payment changes
   * nothing here. What the settlement re-reads, under the buyer's lock, is WHICH tiers the buyer
   * holds now (`settlementVerdict`): only the frozen tier, or nothing when nothing was frozen, is
   * granted; the target itself, any other tier held, or no tier where the opening ranked against one
   * (`frozen-gone`) is a payment taken for a tier that is not granted - logged at ERROR, a
   * refund or a manual grant is owed, and recorded `paid_not_granted`, the durable marker the
   * association's purchases and the hourly report read. Reads through `manager`, under the locks.
   */
  private async settlementMayGrant(
    product: AssociationProduct,
    row: ProductCheckout,
    manager: EntityManager
  ): Promise<boolean> {
    if (product.type !== 'membership') return true;
    const asso = await manager.findOne(Association, { where: { id: product.associationId } });
    const facts = asso ? await this.tierFactsOf(asso, row.userId, manager) : null;
    const heldKeys = facts?.heldKeys ?? [];
    // The frozen tier by PRODUCT id, as it is named now: a retag in between still matches it. A
    // product deleted since names no key, but the opening still froze a tier (`frozen-gone` when
    // nothing is held); a row opened before migration 112 froze nothing.
    const frozen = row.heldTierProductId
      ? facts?.tiers.find((t) => t.id === row.heldTierProductId)
      : undefined;
    const frozenKeys = frozen ? [frozen.variantKey] : [];
    const verdict = settlementVerdict(
      product.variantKey,
      heldKeys,
      frozenKeys,
      Boolean(row.heldTierProductId)
    );
    const describe =
      `product=${product.id.slice(0, 8)} user=${row.userId.slice(0, 8)} ` +
      `held=[${heldKeys.map((k) => k ?? 'base').join(',')}] ` +
      `opened-over=${frozen ? (frozen.variantKey ?? 'base') : row.heldTierProductId ? 'a deleted tier' : 'none'}`;
    if (settlementGrants(verdict)) {
      this.logger.debug(
        `[SHOP] checkout ${row.id.slice(0, 8)}: tier granted (${verdict}) ${describe}`
      );
      return true;
    }
    this.logger.error(
      `[SHOP] checkout ${row.id.slice(0, 8)}: paid tier is ${verdict} at settlement (${describe}) - ` +
        'payment recorded, tier NOT granted; a refund is owed'
    );
    return false;
  }

  /**
   * Takes the buyer's tier lock (`lockBuyerTiers` in `users/buyer-tier-lock.ts`, the ONE
   * implementation every grant path shares) and logs it.
   */
  private async lockBuyerTiers(
    manager: EntityManager,
    associationId: string,
    userId: string
  ): Promise<void> {
    await lockBuyerTiers(manager, associationId, userId);
    this.logger.debug(
      `[SHOP] tier lock held: association=${associationId.slice(0, 8)} user=${userId.slice(0, 8)}`
    );
  }

  /**
   * Records a PAID attempt, exactly once. The attempt row is locked (`FOR UPDATE`) and its
   * transition to `paid`, the purchase record and the granted tag commit together, so two
   * settlements racing on one payment (the callback and the payer's return, or two return reads)
   * produce ONE record: the second finds `paid` under the lock and records nothing. Product, buyer
   * and amount are the ROW's. A `paid` answer over a closed row is still recorded - the money was
   * taken - and logged at ERROR: a request was paid after Canari saw it closed, so the buyer may
   * have been charged twice for one product, which only a human can refund.
   * The Cercle top-up is dispatched after the commit, by the settlement that wrote the record.
   */
  private async settlePaidCheckout(checkoutId: string): Promise<void> {
    const outcome = await this.checkoutRepo.manager.transaction(async (manager) => {
      // Buyer and association never change on an attempt, so they can be read before any lock;
      // the buyer's tier lock comes FIRST, then the row - the order every path takes.
      const head = await manager.findOne(ProductCheckout, { where: { id: checkoutId } });
      if (!head) throw new NotFoundException('Checkout not found');
      await this.lockBuyerTiers(manager, head.associationId, head.userId);
      const row = await manager.findOne(ProductCheckout, {
        where: { id: checkoutId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('Checkout not found');
      if (row.status === 'paid') {
        this.logger.log(
          `[SHOP] checkout ${row.id.slice(0, 8)} already paid - nothing recorded twice`
        );
        return null;
      }
      if (row.status !== 'open') {
        // Money taken over an attempt Canari had closed: the buyer may have paid a later attempt
        // too, so for a non-repeatable product this is very probably a second charge to refund.
        this.logger.error(
          `[SHOP] checkout ${row.id.slice(0, 8)} was ${row.status} and the provider says PAID - ` +
            `recorded; check the buyer's other attempts of product ${row.productId.slice(0, 8)} for a charge to refund`
        );
      }
      // The numeric request id (what callbacks carry, and what core records a payment by), or the
      // uuid. Null only for an attempt whose request/do answer was lost and no callback has stored
      // its id yet: request/state never answers one. Lydia's confirm callback stores it and then
      // completes the record (`completePaidWithoutRequestId`).
      const paymentIntentId = row.requestId ?? row.requestUuid;
      const product = await manager.findOne(AssociationProduct, { where: { id: row.productId } });
      // No initial value: every branch below decides, and the compiler's definite-assignment check
      // refuses a future branch that forgets to - a default here would silently grant it.
      let granted: boolean;
      if (isErasedAccount(row.userId)) {
        // An erasure rewrote the buyer (`[deleted]:<id>`) while the payment was in flight: there is
        // nobody to deliver to. The money is marked for a refund, never granted to the placeholder.
        granted = false;
        this.logger.error(
          `[SHOP] checkout ${row.id.slice(0, 8)}: its buyer account was erased before the payment ` +
            'landed - payment recorded paid_not_granted, nothing granted; a refund is owed'
        );
      } else if (product) {
        granted = await this.settlementMayGrant(product, row, manager);
        if (granted) {
          try {
            granted = await this.grantPurchaseTag(
              manager,
              product,
              row.userId,
              'system',
              paymentIntentId,
              false
            );
          } catch (e) {
            // The buyer holds the tier's tag NAME under another issuer: nothing was written (the
            // upsert does not cross issuers, and raises no SQL error), so the payment is recorded
            // paid but not granted, like a refused rank.
            if (!(e instanceof TagHeldByAnotherIssuerError)) throw e;
            this.logger.error(
              `[SHOP] checkout ${row.id.slice(0, 8)}: paid tier product=${product.id.slice(0, 8)} NOT granted - ` +
                `user=${row.userId.slice(0, 8)} holds its tag name under another issuer; a refund or a fix is owed`
            );
            granted = false;
          }
        }
      } else {
        // Nothing can be delivered for a product that is gone (no tag, no top-up), so the money is
        // recorded with the marker a refund is owed on, never as an ordinary purchase.
        granted = false;
        this.logger.error(
          `[SHOP] checkout ${row.id.slice(0, 8)}: product ${row.productId.slice(0, 8)} no longer exists - ` +
            'payment recorded paid_not_granted, nothing delivered; a refund is owed'
        );
      }
      const record = await this.purchaseRecordService.create(
        {
          // ONE form of an erased buyer on `purchase_records`: the erasure writes `DELETED_ACCOUNT`
          // there, so a record written after it does too, never the checkout's `[deleted]:<id>`, and
          // a count of erased buyers' purchases by `userId` finds both.
          userId: isErasedAccount(row.userId) ? DELETED_ACCOUNT : row.userId,
          source: 'product',
          productId: row.productId,
          amountCents: row.amountCents,
          paymentMethod: 'online',
          status: receivedStatus(granted),
          stripePaymentIntentId: paymentIntentId,
          associationId: row.associationId,
          productName: row.productName,
        },
        manager
      );
      await manager.update(
        ProductCheckout,
        { id: row.id },
        { status: 'paid', settledAt: new Date(), purchaseRecordId: record.id }
      );
      this.logger.log(
        `[SHOP] purchase completed: checkout ${row.id.slice(0, 8)} product=${row.productId.slice(0, 8)} ` +
          `user=${row.userId.slice(0, 8)} amount=${row.amountCents}`
      );
      return { row, product, paymentIntentId, granted };
    });

    // Nothing granted (an erased buyer, a tier not granted) dispatches nothing either.
    if (!outcome?.product || !outcome.granted) return;
    const { row, product, paymentIntentId } = outcome;
    if (!paymentIntentId) {
      if (product.type === 'balance_topup') {
        this.logger.error(
          `[CERCLE] checkout ${row.id.slice(0, 8)}: paid balance top-up with NO Lydia request id yet - ` +
            `top-up NOT dispatched; Lydia's confirm callback carries the id and dispatches it then`
        );
      }
      return;
    }
    await this.dispatchTopUp(row, product, paymentIntentId);
  }

  /**
   * Sends the Cercle top-up of a paid attempt, after its commit, when the product is a top-up with a
   * webhook configured. A dispatch that could not even start is logged: the purchase stays recorded.
   */
  private async dispatchTopUp(
    row: ProductCheckout,
    product: AssociationProduct,
    paymentIntentId: string
  ): Promise<void> {
    if (product.type !== 'balance_topup') return;
    if (!product.webhookUrl || !product.webhookSecret) {
      this.logger.warn(
        `[CERCLE] checkout ${row.id.slice(0, 8)}: top-up product ${product.id.slice(0, 8)} has no webhook configured - nothing dispatched`
      );
      return;
    }
    try {
      await this.dispatchCercleWebhook(product, row.userId, row.amountCents, paymentIntentId);
    } catch (err: unknown) {
      // The purchase is committed; a delivery that could not even be recorded must say so.
      this.logger.error(
        `[CERCLE] checkout ${row.id.slice(0, 8)}: top-up dispatch FAILED to start: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Completes a PAID attempt that was settled before any Lydia request id was known (a lost
   * request/do, settled by its order_ref on the payer's return): its purchase record takes the
   * request id the verified callback carried, and a top-up is dispatched with it. Exactly once: the
   * record is updated only while its payment id is still NULL, and only the call that updated it
   * dispatches. A no-op for every record that already carries an id.
   */
  private async completePaidWithoutRequestId(checkoutId: string, requestId: string): Promise<void> {
    const outcome = await this.checkoutRepo.manager.transaction(async (manager) => {
      const row = await manager.findOne(ProductCheckout, {
        where: { id: checkoutId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row?.purchaseRecordId) {
        this.logger.error(
          `[SHOP] checkout ${checkoutId.slice(0, 8)} is paid but holds no purchase record to complete`
        );
        return null;
      }
      const { affected } = await manager.update(
        PurchaseRecord,
        { id: row.purchaseRecordId, stripePaymentIntentId: IsNull() },
        { stripePaymentIntentId: requestId }
      );
      if (!affected) {
        this.logger.debug(
          `[SHOP] checkout ${row.id.slice(0, 8)}: its purchase record already carries its payment id`
        );
        return null;
      }
      this.logger.log(
        `[SHOP] checkout ${row.id.slice(0, 8)}: purchase record completed with request ${requestId}`
      );
      // An erased buyer's payment was recorded `paid_not_granted` (`settlePaidCheckout`): nothing
      // is delivered for it, a top-up no more than a tier.
      if (isErasedAccount(row.userId)) {
        this.logger.warn(
          `[SHOP] checkout ${row.id.slice(0, 8)}: buyer erased - nothing dispatched, a refund is owed`
        );
        return null;
      }
      const product = await manager.findOne(AssociationProduct, { where: { id: row.productId } });
      return product ? { row, product } : null;
    });
    if (outcome) await this.dispatchTopUp(outcome.row, outcome.product, requestId);
  }

  /** The typed 409 of a double click, logged with its reason. */
  private checkoutInProgress(productId: string, userId: string, reason: string): ConflictException {
    this.logger.warn(
      `[SHOP] checkout refused: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)} (${reason})`
    );
    return new ConflictException({
      code: CHECKOUT_IN_PROGRESS,
      message: 'Another checkout of yours is already being opened.',
    });
  }

  /**
   * The typed 409 of a previous attempt whose fate could not be established, logged with its reason.
   * Its sentence is TRUE: `settlePreviousOpenAttempt` stops refusing at `expiresAt` +
   * `CHECKOUT_EXPIRY_MARGIN_MS`, 35 minutes after the attempt was opened.
   */
  private previousCheckoutOpen(checkoutId: string, reason: string): ConflictException {
    this.logger.warn(
      `[SHOP] checkout ${checkoutId.slice(0, 8)}: previous payment request still open (${reason}) - refused`
    );
    return new ConflictException({
      code: PREVIOUS_CHECKOUT_OPEN,
      message:
        'A previous payment request of yours is still open. Try again once it has expired, at most 35 minutes after it was started.',
    });
  }

  /**
   * Refuses an amount outside a free-amount product's own bounds with the typed
   * `AMOUNT_OUT_OF_RANGE` (both bounds, `null` max = unbounded), logged at the decision. ONE check
   * for both ways an amount reaches such a product: the buyer's checkout and the manager's cash grant.
   */
  private assertWithinCustomBounds(
    product: AssociationProduct,
    associationId: string,
    amountCents: number,
    what: 'custom amount' | 'cash grant amount'
  ): void {
    const min = product.customAmountMinCents ?? 0;
    const max = product.customAmountMaxCents ?? null;
    if (amountCents >= min && (max === null || amountCents <= max)) return;
    const allowed = `${min}-${max ?? 'unbounded'}`;
    this.logger.warn(
      `[SHOP] ${what} refused: product=${product.id.slice(0, 8)} association=${associationId.slice(0, 8)} ` +
        `amount=${amountCents} allowed=${allowed} cents`
    );
    throw amountOutOfRange(min, max, `The ${what} must be between ${allowed} cents`);
  }

  /**
   * Loads product/association, validates purchase rules, and resolves the amount in cents:
   * `preparePurchase` (everything that calls another service) then `decidePurchase`.
   */
  private async resolvePurchase(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number
  ): Promise<ResolvedPurchase> {
    const prepared = await this.preparePurchase(associationId, productId, userId);
    return this.decidePurchase(prepared, userId, customAmountCents, this.productRepo.manager);
  }

  /**
   * The half of a purchase that CALLS other services, run BEFORE the buyer's tier lock: the active
   * payment provider (core-service), the routing it gives, and - for a grid priced on promo or
   * formation - the buyer's profile (core-service). A slow peer must never hold the lock.
   */
  private async preparePurchase(
    associationId: string,
    productId: string,
    userId: string
  ): Promise<PreparedPurchase> {
    const [asso, product] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.productRepo.findOne({ where: { id: productId, associationId } }),
    ]);

    if (!asso) throw new NotFoundException('Association not found');
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive) {
      throw new NotFoundException('Product not found or inactive');
    }
    // The shop lists only the associations the buyer can see (`listAllActive`), and a purchase by
    // id is held to the same predicate: a product of an association the buyer cannot see answers
    // exactly like one that does not exist. A member of it (D21) is inside the predicate.
    if (!(await associationVisibleTo(this.productRepo.manager, associationId, userId))) {
      this.logger.log(
        `[SHOP] purchase refused: product=${product.id.slice(0, 8)} - association ` +
          `${associationId.slice(0, 8)} is not visible to ${userId.slice(0, 8)}`
      );
      throw new NotFoundException('Product not found');
    }

    // Route to the association's own account, or an approved parent's when delegating.
    const provider = await this.activePaymentProvider();
    const paymentTarget = await this.routeWith(asso, provider);
    const vendorToken = paymentTarget.connectAccountId;
    if (!paymentTarget.ready || !vendorToken) {
      this.logger.warn(
        `[SHOP] refused: product=${product.id.slice(0, 8)} - payments not ready ` +
          `(provider=${paymentTarget.provider} delegated=${paymentTarget.delegated} ` +
          `cause=${paymentTarget.readinessCause ?? 'none'})`
      );
      if (paymentTarget.provider === 'disabled') {
        throw new BadRequestException(PAYMENTS_DISABLED_MESSAGE);
      }
      throw paymentsNotReady(paymentTarget.readinessCause, paymentTarget.delegated);
    }
    const profileFetched = product.priceMatrix
      ? dimensionsNeedProfile(product.priceMatrix.dimensions)
      : false;
    const profile = await this.pricingFacts.profileFor(userId, profileFetched);
    return {
      associationId,
      productId,
      provider,
      paymentTarget,
      vendorToken,
      profile,
      profileFetched,
    };
  }

  /**
   * The half of a purchase that reads only this database, so it may run under the buyer's tier
   * lock: reloads the association and the product BY ID, re-validates the routing
   * `preparePurchase` decided against them (`routeWith`, no call: same provider, the parent read by
   * id) and refuses `PAYMENT_ROUTING_CHANGED` if ANY field of it changed (`sameRouting`), and
   * `PURCHASE_PRICING_CHANGED` if the grid now needs a profile that was not fetched - then ranks and
   * prices.
   * EVERY read goes through `manager`, the lock holder's transaction: a read on another pool
   * connection would hold the buyer's lock while waiting for a free connection. Sequential, since
   * one connection runs one query at a time.
   */
  private async decidePurchase(
    prepared: PreparedPurchase,
    userId: string,
    customAmountCents: number | undefined,
    manager: EntityManager
  ): Promise<ResolvedPurchase> {
    const { associationId, productId, paymentTarget, vendorToken } = prepared;
    const asso = await manager.findOne(Association, { where: { id: associationId } });
    const product = await manager.findOne(AssociationProduct, {
      where: { id: productId, associationId },
    });
    if (!asso) throw new NotFoundException('Association not found');
    if (!product) throw new NotFoundException('Product not found');
    const now = await this.routeWith(asso, prepared.provider, manager);
    // Read BEFORE the product's own flag: a readiness revert committed while the purchase was being
    // prepared both clears the target's readiness and withholds the product, and the payer is owed
    // the reason (payments not active), not "product not found" nor a routing change.
    if (!now.ready) {
      this.logger.warn(
        `[SHOP] refused under the lock: product=${product.id.slice(0, 8)} - payments stopped being ` +
          `ready while the purchase was being prepared (cause=${now.readinessCause ?? 'none'})`
      );
      throw paymentsNotReady(now.readinessCause, now.delegated);
    }
    if (!product.isActive) {
      throw new NotFoundException('Product not found or inactive');
    }
    if (!sameRouting(now, paymentTarget)) {
      this.logger.warn(
        `[SHOP] refused (${PAYMENT_ROUTING_CHANGED}): product=${product.id.slice(0, 8)} - the payment ` +
          'routing changed while the purchase was being prepared'
      );
      throw new ConflictException({
        code: PAYMENT_ROUTING_CHANGED,
        message: 'The payment account of this association changed while the purchase was opened.',
      });
    }

    this.assertMembershipGrantable(asso, product);

    // The profile is the one other input fetched before the lock: a grid that now needs it, read
    // under the lock, would otherwise be priced on the "everyone else" cell without it.
    if (
      product.priceMatrix &&
      dimensionsNeedProfile(product.priceMatrix.dimensions) &&
      !prepared.profileFetched
    ) {
      this.logger.warn(
        `[SHOP] refused (${PURCHASE_PRICING_CHANGED}): product=${product.id.slice(0, 8)} - its grid ` +
          'now prices on the profile, which was not fetched while the purchase was being prepared'
      );
      throw new ConflictException({
        code: PURCHASE_PRICING_CHANGED,
        message: 'The pricing of this product changed while the purchase was opened.',
      });
    }

    const facts = await this.tierFactsOf(asso, userId, manager);
    const isCotisant = (facts?.heldKeys.length ?? 0) > 0;
    if (product.type === 'membership') {
      this.assertTierIsARise(product, facts, userId);
      await this.assertNoSiblingAttemptOpen(product, userId, manager);
    }
    await this.assertCanPurchase(product, userId, isCotisant, manager);

    let amountCents: number;
    if (product.priceMatrix) {
      // A grid REPLACES the fixed pricing, it never layers on it: `amountCents`, `amountCentsMember`
      // and `memberPriceTag` decide nothing while one is set. Two mechanisms for "some people pay
      // less" would need an order between them, and an order that decides money is the priority
      // rule this whole design exists in order not to have.
      const cell = this.resolveGridPrice(
        product.priceMatrix,
        facts?.heldKeys ?? [],
        prepared.profile
      );
      if (cell === null) {
        this.logger.log(
          `[SHOP] purchase refused by the grid: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} - ` +
            'the association marked this combination as not sold'
        );
        throw new BadRequestException('This is not available for your situation.');
      }
      amountCents = cell;
      this.logger.debug(
        `[SHOP] grid price applied: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`
      );
    } else if (product.amountCents !== null) {
      const price = this.fixedPriceOf(product, product.amountCents, facts);
      amountCents = price.amountCents;
      if (price.preferential) {
        this.logger.debug(
          `[SHOP] member price applied: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`
        );
      }
    } else if (product.allowCustomAmount && customAmountCents !== undefined) {
      this.assertWithinCustomBounds(product, associationId, customAmountCents, 'custom amount');
      amountCents = customAmountCents;
    } else {
      throw new BadRequestException('No amount provided for this product');
    }

    // What the opening decided, frozen on the row: the tier it ranked against. The settlement grants
    // on it and never re-reads a price (`settlementMayGrant`). An opened tier checkout over a held
    // tier always has that tier's product: a held tag with no product is `unranked`, refused above.
    const heldTierProductId =
      product.type === 'membership' ? this.heldTierProductIdOf(facts) : null;
    return { asso, product, amountCents, paymentTarget, vendorToken, heldTierProductId };
  }

  /**
   * Lists all completed purchases for an association (boutique + paid forms).
   * Requires MANAGE_PRODUCTS on the association (enforced by controller).
   */
  async listAssociationPurchases(associationId: string): Promise<PurchaseListRow[]> {
    const records = await this.purchaseRecordService.listPaidByAssociation(associationId);
    return this.enrichPurchaseRecords(records);
  }

  /**
   * Builds an XLSX export of an association's completed purchases (boutique + paid forms), the
   * same rows as `listAssociationPurchases`. Used by the association's own accounting view and by
   * an approved parent's delegated-accounting view. Columns match the treasurer-facing table.
   */
  async exportAssociationPurchases(
    associationId: string
  ): Promise<{ buffer: Buffer; title: string }> {
    this.logger.debug(`[SHOP] exportAssociationPurchases assoc=${associationId.slice(0, 8)}`);
    const nameRows: { name: string }[] = await this.productRepo.manager.query(
      `SELECT name FROM associations WHERE id = $1`,
      [associationId]
    );
    const assocName = nameRows[0]?.name ?? 'achats';
    const purchases = await this.listAssociationPurchases(associationId);

    // Every French cell and header below is written as an escape, so this source stays ASCII.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Achats');
    sheet.columns = [
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Pr\u00e9nom', key: 'firstName', width: 20 },
      { header: 'Type', key: 'source', width: 12 },
      { header: 'Produit', key: 'productName', width: 30 },
      { header: 'Montant', key: 'amount', width: 12, style: { numFmt: '0.00 "\u20ac"' } },
      { header: 'Paiement', key: 'paymentMethod', width: 12 },
      { header: 'Date', key: 'paidAt', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
      { header: 'Statut', key: 'status', width: 30 },
      {
        header: 'Montant conserv\u00e9',
        key: 'kept',
        width: 16,
        style: { numFmt: '0.00 "\u20ac"' },
      },
    ];

    purchases.forEach((p) => {
      sheet.addRow({
        // A guest (no account) is named as the responses table names one; the organiser finds the
        // person through the form's own answers ("Nom Prenom").
        lastName: p.lastName ?? (p.userId ? '' : 'Invit\u00e9'),
        firstName: p.firstName ?? '',
        source: p.source === 'form' ? 'Formulaire' : 'Boutique',
        productName: p.productName,
        amount: p.amountCents / 100,
        // The sheet is French throughout, and this column says HOW rather than THROUGH WHOM:
        // 'Stripe' named the processor of the day, and the app's own label for the same fact
        // is `asso_achats_payment_online`.
        paymentMethod: p.paymentMethod === 'cash' ? 'Esp\u00e8ces' : 'En ligne',
        paidAt: new Date(p.paidAt),
        // A tier paid for and not granted is money received that a refund or a grant must settle.
        // Closed or not, the mark stays: the column says how it was settled, if it was.
        status: !p.notGranted
          ? 'Pay\u00e9'
          : p.closedOutcome === 'refunded'
            ? 'Pay\u00e9, non accord\u00e9 : rembours\u00e9'
            : p.closedOutcome === 'granted'
              ? 'Pay\u00e9, non accord\u00e9 : accord\u00e9 \u00e0 la main'
              : 'Pay\u00e9, non accord\u00e9 : \u00e0 r\u00e9gulariser',
        // What the association keeps: a refunded payment went back, so a sum of this column is the
        // income, where a sum of `Montant` is what was ever received. An OPEN payment not granted
        // counts as kept until its refund is recorded - its `Statut` says it is still to settle.
        kept: p.closedOutcome === 'refunded' ? 0 : p.amountCents / 100,
      });
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, title: `achats_${assocName}` };
  }

  /**
   * Lists completed purchases for a boutique product with buyer display names.
   * Requires MANAGE_PRODUCTS on the association (enforced by controller).
   */
  async listProductPurchases(
    associationId: string,
    productId: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      amountCents: number;
      paidAt: string;
      firstName: string | null;
      lastName: string | null;
    }>
  > {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');

    const records = await this.purchaseRecordService.listPaidByProduct(productId);
    return this.enrichPurchaseRecords(records);
  }

  /**
   * Attaches buyer display names, and the closing of each record marked `paid_not_granted`, to
   * purchase records. `manager` reads inside the caller's transaction (a closing answering its row).
   */
  private async enrichPurchaseRecords(
    records: PurchaseRecord[],
    manager: EntityManager = this.productRepo.manager
  ): Promise<PurchaseListRow[]> {
    // A guest's payment on a public form names no buyer (migration 103): nobody to look up.
    const userIds = [...new Set(records.map((r) => r.userId).filter((id) => id != null))];
    const nameMap = new Map<string, { firstName: string | null; lastName: string | null }>();
    if (userIds.length > 0) {
      const rows: { id: string; firstName: string | null; lastName: string | null }[] =
        await manager.query(`SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`, [
          userIds,
        ]);
      rows.forEach((r) => nameMap.set(r.id, { firstName: r.firstName, lastName: r.lastName }));
    }

    // Only a record marked `paid_not_granted` can have been closed: nothing to read without one.
    const marked = records.filter((r) => r.status === 'paid_not_granted').map((r) => r.id);
    const closings =
      marked.length > 0
        ? await this.purchaseRecordService.closingsOf(marked, manager)
        : new Map<string, PurchaseRecordClosing>();

    // An OPEN marked payment says whether it can still be granted, and over what: the decision the
    // closing takes under the lock, read here without one (the list is advice; the closing decides).
    const verdicts = new Map<string, ClosingGrantVerdict>();
    const open = records.filter((r) => r.status === 'paid_not_granted' && !closings.has(r.id));
    // ONE context per association listed, whatever the number of open rows.
    for (const associationId of new Set(open.map((r) => r.associationId))) {
      const own = open.filter((r) => r.associationId === associationId);
      const ctx = await this.closingContextOf(manager, associationId, own);
      for (const r of own) verdicts.set(r.id, await this.closingGrantVerdict(r, ctx));
    }

    return records.map((r) => ({
      id: r.id,
      userId: r.userId,
      source: r.source,
      productId: r.productId,
      formId: r.formId,
      productName: r.productName,
      amountCents: r.amountCents,
      paymentMethod: r.paymentMethod,
      paidAt: r.paidAt.toISOString(),
      firstName: nameMap.get(r.userId)?.firstName ?? null,
      lastName: nameMap.get(r.userId)?.lastName ?? null,
      notGranted: r.status === 'paid_not_granted',
      closedOutcome: closings.get(r.id)?.outcome ?? null,
      closedAt: closings.get(r.id)?.createdAt.toISOString() ?? null,
      grantRefusal: verdicts.get(r.id)?.refusal ?? null,
      buyerTier: verdicts.get(r.id)?.buyerTier ?? null,
      delivered: Boolean(verdicts.get(r.id)?.deliveredTagId),
    }));
  }

  /**
   * Resolves a user's cotisant status for an association by slug, for the inbound Cercle
   * `GET /public/cotisant-status` check (WP-COT-4). Mirrors `isBuyerCotisant`'s tier enumeration
   * but also surfaces WHICH tier tag is held and its expiry, since Cercle needs to distinguish
   * forfaits rather than a plain yes/no. Throws NotFoundException for an unknown slug.
   */
  async getCotisantStatusBySlug(
    assoSlug: string,
    userId: string
  ): Promise<{ isCotisant: boolean; tier: string | null; expiresAt: string | null }> {
    const asso = await this.assoRepo.findOne({ where: { slug: assoSlug } });
    if (!asso) throw new NotFoundException('Association not found');
    if (!asso.cotisationMode) return { isCotisant: false, tier: null, expiresAt: null };

    // Deliberately not filtered on `isActive`: a tier withdrawn from sale (or never put on sale,
    // an association with no Stripe account yet) still has cotisants, and answering `false` here
    // locks every one of them out of the Cercle.
    const tiers = await this.productRepo.find({
      where: { associationId: asso.id, type: 'membership' },
      select: { variantKey: true },
    });
    for (const variantKey of tierVariantKeys(tiers)) {
      const { tagName } = deriveCotisationTag(
        asso.slug,
        asso.cotisationMode,
        new Date(),
        variantKey
      );
      const tag = await this.userTagService.getActiveTag(userId, tagName, asso.id);
      if (tag) {
        return {
          isCotisant: true,
          tier: variantKey,
          expiresAt: tag.expiresAt?.toISOString() ?? null,
        };
      }
    }
    return { isCotisant: false, tier: null, expiresAt: null };
  }

  /**
   * Returns true when the user holds ANY of the association's active tier tags (see
   * `deriveCotisationTag`/`tierVariantKeys`) - i.e. is a cotisant of at least one tier, regardless
   * of which. Kept deliberately generic (not tier-specific) so `membersOnly` gating and the Cercle
   * `balance_topup` recharge stay open to every forfait, per-tier gating being what `requiredTags`
   * is for. Always false when the association has no cotisation mode configured (`cotisationMode`
   * null), regardless of `cotisationEnabled`.
   *
   * Public: also reused by `PartnershipsService` to gate `membersOnly` partnership cards on the
   * exact same cotisant definition, rather than duplicating the tier-enumeration logic.
   */
  async isBuyerCotisant(asso: Association, userId: string): Promise<boolean> {
    return ((await this.tierFactsOf(asso, userId))?.heldKeys.length ?? 0) > 0;
  }

  /**
   * `tierFactsFrom` for one user in one association, reading the association's tiers (on sale or
   * not - holding a withdrawn tier's tag still makes you a cotisant) and the user's tags ISSUED BY
   * that association: a tag of the same name issued elsewhere holds no tier here.
   */
  private async tierFactsOf(
    asso: Association,
    userId: string,
    manager: EntityManager = this.productRepo.manager
  ): Promise<TierFacts | null> {
    if (!asso.cotisationMode) return null;
    const tiers = await manager.find(AssociationProduct, {
      where: { associationId: asso.id, type: 'membership' },
      select: TIER_RANK_COLUMNS,
    });
    const orphans = await this.userTagService.heldOrphanTierTags(userId, asso.id, tiers, manager);
    return this.tierFactsFrom(
      asso,
      tiers,
      (tag) => this.userTagService.hasActiveTag(userId, tag, asso.id, manager),
      orphans
    );
  }

  /**
   * The product id of the tier a purchase is ranked against (`TierFacts.held`, picked by
   * `pickHeldTier`), which a checkout opening freezes on its row: null when nothing is held.
   *
   * Deterministic when two products carry the held key (a catalogue from before the key was kept
   * unique per association): the smallest id, logged at WARN. Either one names the same key while
   * both exist. If the frozen one is deleted before the settlement, the frozen key is lost with it
   * and the settlement reads `held-changed`: recorded `paid_not_granted`, reported, closed by a
   * person - the cautious outcome, never a grant over a tier nobody ranked.
   */
  private heldTierProductIdOf(facts: TierFacts | null): string | null {
    const held = facts?.held;
    if (!held) return null;
    const ids = facts.tiers
      .filter((t) => t.variantKey === held.variantKey)
      .map((t) => t.id)
      .sort();
    if (ids.length > 1) {
      this.logger.warn(
        `[SHOP] ${ids.length} tier products share key ${held.variantKey ?? 'base'} - freezing ` +
          `the smallest id ${ids[0].slice(0, 8)}; the catalogue should hold one per key`
      );
    }
    return ids[0] ?? null;
  }

  /**
   * Where a tier product stands against what the viewer holds (`tierRelationOf`): `none` without
   * facts. A viewer holding TWO tiers at once is `unranked` for any tier but one they hold: ranked
   * against one of them, a checkout would freeze only that one and its settlement would read the
   * other as `held-changed`, taking the money for nothing (`assertTierIsARise` words that case).
   * ONE call shared by the listing and the checkout, so the screen never offers what the checkout
   * refuses; the settlement decides on what the checkout froze (`settlementMayGrant`).
   */
  private relationOf(product: AssociationProduct, facts: TierFacts | null): TierRelation {
    if (!facts) return 'none';
    const relation = tierRelationOf(product, facts.heldKeys, facts.held);
    return relation !== 'held' && facts.heldKeys.length > 1 ? 'unranked' : relation;
  }

  /**
   * Refuses `CHECKOUT_IN_PROGRESS` when the buyer has an OPEN attempt of a SIBLING tier: one tier
   * only can be held, so a buyer must never hold two payable requests for two of them. Asked under
   * the buyer's tier lock, so two tabs opening two tiers at once cannot both pass - the second
   * reads the first one's committed row. (`productsToSettleBefore` settled the siblings' open
   * attempts before the lock; this catches one opened since.) The same product is the partial
   * unique index's job.
   */
  private async assertNoSiblingAttemptOpen(
    product: AssociationProduct,
    userId: string,
    manager: EntityManager
  ): Promise<void> {
    const open: { productId: string }[] = await manager.query(
      `SELECT c."productId" FROM product_checkouts c
         JOIN association_products p ON p.id = c."productId"
        WHERE c."userId" = $1 AND c.status = 'open' AND c."productId" <> $2
          AND p."associationId" = $3 AND p.type = 'membership'
        LIMIT 1`,
      [userId, product.id, product.associationId]
    );
    if (open.length === 0) return;
    throw this.checkoutInProgress(
      product.id,
      userId,
      `an attempt of sibling tier ${open[0].productId.slice(0, 8)} is open`
    );
  }

  /**
   * Refuses a cotisation tier that is not a RISE over the tier the buyer holds active (user,
   * 2026-10-26), since the sibling XOR at settlement would replace the held tier. Decided before
   * the purchase records are read, so the answer does not depend on how the held tier was obtained
   * (paid, cash, manual grant, claimed legacy row):
   *
   * - `held` -> `PRODUCT_ALREADY_PURCHASED`;
   * - `lower` (cheaper or equally priced) -> `TIER_NOT_A_RISE`;
   * - `unranked` (the held tier or the target has no rankable price: a grid, a free amount, a named tier with none - `rankPriceCents`) -> `TIER_NOT_RANKABLE`;
   * - `none` and `higher` pass, at `fixedPriceFor`'s amount.
   */
  private assertTierIsARise(
    product: AssociationProduct,
    facts: TierFacts | null,
    userId: string
  ): void {
    const held = facts?.held ?? null;
    const relation = this.relationOf(product, facts);
    this.logger.debug(
      `[SHOP] tier rank: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} ` +
        `held=${held ? (held.variantKey ?? 'base') : 'none'} relation=${relation}`
    );
    // A buyer holding TWO tiers at once is `unranked` (`relationOf`), refused here before any
    // request is opened, with the sentence that names the cause. (Not seen in production on
    // 2026-10-27; holding two is a data fault the roster corrects.)
    if (relation === 'unranked' && (facts?.heldKeys.length ?? 0) > 1) {
      this.logger.warn(
        `[SHOP] refused (${TIER_NOT_RANKABLE}): product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} ` +
          `holds ${facts?.heldKeys.length} tiers at once - no single tier to rank against`
      );
      throw new ConflictException({
        code: TIER_NOT_RANKABLE,
        message: 'You hold several membership tiers at once: the association must correct it first',
      });
    }
    const refusal = tierRefusal(relation);
    if (!refusal) return;
    this.logger.log(
      `[SHOP] refused (${refusal.code}): product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} ` +
        `holds tier ${held?.variantKey ?? 'base'}`
    );
    throw new ConflictException(refusal);
  }

  /** Returns true when the user holds at least one of the given tag names. */
  private async hasAnyActiveTag(
    userId: string,
    tagNames: string[],
    manager: EntityManager
  ): Promise<boolean> {
    for (const tagName of tagNames) {
      if (await this.userTagService.hasActiveTagFromAnyIssuer(userId, tagName, manager)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Enforces member-gating, per-user/global purchase limits, and membership renewal rules. Reads
   * through `manager` (the checkout's transaction, under the buyer's tier lock).
   */
  private async assertCanPurchase(
    product: AssociationProduct,
    userId: string,
    isCotisant: boolean,
    manager: EntityManager
  ): Promise<void> {
    const requiredTags = product.requiredTags ?? [];
    this.logger.debug(
      `[SHOP] assertCanPurchase: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} membersOnly=${product.membersOnly} requiredTags=${requiredTags.length} isCotisant=${isCotisant}`
    );
    // requiredTags generalizes membersOnly (any listed tag, not just the asso's own cotisation
    // tiers) and takes precedence when set; membersOnly falls back to "any active tier tag of
    // the owning association" (isCotisant, back-compat).
    const gateFailed =
      requiredTags.length > 0
        ? !(await this.hasAnyActiveTag(userId, requiredTags, manager))
        : product.membersOnly && !isCotisant;
    if (gateFailed) {
      this.logger.debug(
        `[SHOP] rejected: product=${product.id.slice(0, 8)} gating not satisfied for user=${userId.slice(0, 8)}`
      );
      throw requiredTags.length > 0
        ? new ForbiddenException(
            'This product is reserved to users holding one of the required tags'
          )
        : new ForbiddenException({
            code: PRODUCT_COTISANTS_ONLY,
            message: "This product is reserved to the association's cotisants",
          });
    }

    // A balance top-up is a recharge of an account on another site: repeatable by definition and
    // impossible to exhaust. The three shop columns below are meaningless for that type, and a row
    // created before `create`/`update` started forcing them still carries the restrictive defaults
    // - so the TYPE decides here, not the stored data.
    if (product.type === 'balance_topup') {
      this.logger.debug(
        `[SHOP] purchase limits waived: balance_topup product=${product.id.slice(0, 8)}`
      );
      return;
    }

    const paidCount = await this.purchaseRecordService.countPaidByUserAndProduct(
      userId,
      product.id,
      manager
    );

    if (product.maxPurchasesTotal != null) {
      const totalPaid = await this.purchaseRecordService.countPaidByProduct(product.id, manager);
      if (totalPaid >= product.maxPurchasesTotal) {
        throw new BadRequestException('Ce produit est en rupture de stock');
      }
    }

    if (product.allowRepeatPurchase) {
      if (product.maxPurchasesPerUser != null && paidCount >= product.maxPurchasesPerUser) {
        throw new BadRequestException("Limite d'achats atteinte pour ce produit");
      }
      return;
    }

    if (paidCount === 0) return;

    if (product.type === 'membership' && product.grantedTagName) {
      // Renewal: allow re-buying once the CURRENT tag has expired. Resolve the effective tag
      // (derived per academic year for cotisation-mode associations) rather than the stored one,
      // so the check stays correct across a yearly rollover.
      const grant = await this.resolveGrantTag(product, manager);
      if (grant) {
        const hasTag = await this.userTagService.hasActiveTag(
          userId,
          grant.tagName,
          product.associationId,
          manager
        );
        if (!hasTag) return;
      }
    }

    // Decided HERE, from the purchase records, before any request is issued: Lydia must never be
    // the one to refuse a second purchase (it refused the reused order_ref instead, error 3).
    this.logger.log(
      `[SHOP] refused: product=${product.id.slice(0, 8)} already purchased by user=${userId.slice(0, 8)}`
    );
    throw new ConflictException({
      code: PRODUCT_ALREADY_PURCHASED,
      message: 'You have already purchased this product',
    });
  }

  /**
   * Manually records a product purchase for a user (cash payment, retroactive grant).
   * Grants membership tags like a real purchase but does not dispatch Cercle webhooks.
   *
   * With no `dto.amountCents`, the amount recorded is the one the checkout would charge this
   * beneficiary: their grid cell, or the fixed price - the preferential one when they qualify.
   */
  async grantProductPurchase(
    associationId: string,
    productId: string,
    grantedBy: string,
    dto: GrantProductPurchaseDto
  ): Promise<{
    id: string;
    userId: string;
    source: 'form' | 'product';
    productId: string | null;
    formId: string | null;
    productName: string;
    amountCents: number;
    paymentMethod: PurchasePaymentMethod;
    paidAt: string;
    firstName: string | null;
    lastName: string | null;
  }> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product) throw new NotFoundException('Product not found');

    // A cash grant records a sale in Canari's books; it never credits the Cercle balance, because
    // the outbound webhook is keyed by a Stripe PaymentIntent a cash sale does not have. Recording
    // one against a top-up product therefore produces a line that reads as a recharge and is not
    // one - the confusion outweighs the accounting. The Cercle credits from its own till screen.
    if (product.type === 'balance_topup') {
      this.logger.warn(
        `[SHOP] refused a cash grant on balance_topup product=${productId.slice(0, 8)} by=${grantedBy.slice(0, 8)}`
      );
      throw new BadRequestException(
        'A balance top-up cannot be granted as a cash sale: it would not credit the Cercle account. Credit the member from the Cercle instead.'
      );
    }

    const userRows: { id: string }[] = await this.productRepo.manager.query(
      `SELECT id FROM users WHERE id = $1`,
      [dto.userId]
    );
    if (userRows.length === 0) throw new NotFoundException('User not found');

    let amountCents: number;
    if (dto.amountCents != null) {
      // A TYPED amount is what the bounds of a free-amount product bind - never the default resolved
      // below, which is a price the checkout charges with no bounds check either. Typing the very
      // amount the screen quoted is that default, so it is not bound either.
      if (product.allowCustomAmount) {
        const quote = await this.cashSaleQuoteFor(product, dto.userId);
        if (quote.kind !== 'priced' || quote.amountCents !== dto.amountCents) {
          this.assertWithinCustomBounds(
            product,
            associationId,
            dto.amountCents,
            'cash grant amount'
          );
        }
      }
      amountCents = dto.amountCents;
    } else {
      const quote = await this.cashSaleQuoteFor(product, dto.userId);
      if (quote.kind === 'not-sold') {
        throw new BadRequestException(
          'The pricing grid does not sell this product to that person, so there is no amount to record.'
        );
      }
      if (quote.kind === 'typed') {
        throw new BadRequestException('amountCents is required for this product');
      }
      amountCents = quote.amountCents;
    }

    this.logger.log(
      `[SHOP] manual grant: product=${productId.slice(0, 8)} user=${dto.userId.slice(0, 8)} by=${grantedBy.slice(0, 8)}`
    );

    const record = await this.fulfillProductPurchase({
      product,
      userId: dto.userId,
      amountCents,
      paymentMethod: 'cash',
      stripePaymentIntentId: null,
      grantedBy,
    });
    const [enriched] = await this.enrichPurchaseRecords([record]);
    return enriched;
  }

  /**
   * The amount a cash sale of `productId` to `userId` records when the cashier types none - what
   * the cashier's screen shows before the sale, from the same `cashSaleQuoteFor` the sale itself
   * calls, so the two cannot disagree. 404 for a product of another association or a top-up (no
   * cash sale of one exists).
   */
  async quoteCashSale(
    associationId: string,
    productId: string,
    userId: string
  ): Promise<CashSaleQuote> {
    const product = await this.productRepo.findOne({ where: { id: productId, associationId } });
    if (!product || product.type === 'balance_topup') {
      throw new NotFoundException('Product not found');
    }
    const quote = await this.cashSaleQuoteFor(product, userId);
    this.logger.debug(
      `[SHOP] cash sale quoted: product=${productId.slice(0, 8)} user=${userId.slice(0, 8)} kind=${quote.kind}`
    );
    return quote;
  }

  /**
   * What the checkout would charge this beneficiary, which a cash sale records by default (user,
   * 2026-10-29): their grid cell (`not-sold` when the grid closes their combination), else the fixed
   * price through `fixedPriceOf` - the preferential one when they qualify - else `typed`, a
   * free-amount product the cashier must type an amount for. Read before the buyer's tier lock, as
   * the backlog's P3 says: one tier stale at worst, never the grant itself.
   */
  private async cashSaleQuoteFor(
    product: AssociationProduct,
    userId: string
  ): Promise<CashSaleQuote> {
    const associationId = product.associationId;
    if (product.priceMatrix) {
      // A grid replaces the fixed pricing: falling back to `amountCents` here would record a price
      // the grid never quoted, and `amountCents` may not even be set.
      const cell = this.resolveGridPrice(
        product.priceMatrix,
        await this.userTagService.listHeldCotisationTiers(userId, associationId),
        await this.pricingFacts.profileFor(
          userId,
          dimensionsNeedProfile(product.priceMatrix.dimensions)
        )
      );
      return cell === null
        ? { kind: 'not-sold' }
        : { kind: 'priced', amountCents: cell, preferential: false };
    }
    if (product.amountCents == null) return { kind: 'typed' };
    const asso = await this.assoRepo.findOne({ where: { id: associationId } });
    if (!asso) throw new NotFoundException('Association not found');
    const price = this.fixedPriceOf(
      product,
      product.amountCents,
      await this.tierFactsOf(asso, userId)
    );
    if (price.preferential) {
      this.logger.debug(
        `[SHOP] cash sale at the member price: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${price.amountCents}`
      );
    }
    return { kind: 'priced', ...price };
  }

  /**
   * CLOSES a payment marked `paid_not_granted` (user, 2026-10-27; migration 113): a manager records
   * WHICH outcome settled it - `refunded` (the money went back, outside Canari) or `granted` (the tier
   * is granted by hand, here, by the manual grant path `grantCotisantWithin`). One durable row per
   * purchase record, its time the server's own `now()`; the record keeps its mark as history, and the
   * hourly report stops counting it (`PaidNotGrantedScheduler`). No clock closes anything.
   *
   * Everything runs in ONE transaction, in the order every tier path takes: the association's and the
   * buyer's tier locks (`lockBuyerTiers`), the purchase record row (`FOR UPDATE`), then the tags. So a
   * grant here cannot interleave with a settlement or another grant of that buyer, and two closings of
   * one payment run one after the other: the second reads the first one's row and is refused
   * `PURCHASE_ALREADY_CLOSED`. The unique index is the durable guarantee under that check.
   *
   * Refusals, typed: 404 when the record is not this association's; 409 `PURCHASE_NOT_CLOSABLE` when
   * it is not marked `paid_not_granted`; 409 `PURCHASE_ALREADY_CLOSED`; and for `granted`, the 409 of
   * each `ClosingGrantRefusal` (`closingGrantVerdict`), judged on the LOCKED row under the buyer's
   * tier lock, so an erasure or a grant committed while this waited is seen. `granted` is a manual
   * grant, but a protected one: it only ever grants a first tier or a RISE - never a renewal of the
   * tier held (that payment is owed a refund, and closing it as granted would take it off the report)
   * nor a move down. A tier held because it IS this payment's delivery (`deliveryOf`) is recorded
   * `granted` with nothing granted - its tag is only stamped with the record, so one delivery closes
   * one payment - and the books do not book a refund that never happened. Nothing is written by a refusal, and `refunded` stays open in each case, so the
   * report can always be drained.
   *
   * Only `granted` takes the buyer's tier lock: `refunded` writes no tag, and two closings of one
   * payment are already serialised by the row lock.
   */
  async closePaidNotGranted(
    associationId: string,
    purchaseId: string,
    closedBy: string,
    outcome: PurchaseClosingOutcome,
    expectDelivered: boolean
  ): Promise<PurchaseListRow> {
    this.logger.debug(
      `[SHOP] closing purchase=${purchaseId.slice(0, 8)} association=${associationId.slice(0, 8)} as ${outcome}`
    );
    // Buyer and association never change on a record, so they can be read before any lock; the
    // locks come FIRST, then the row - the order every tier path takes.
    const head = await this.productRepo.manager.findOne(PurchaseRecord, {
      where: { id: purchaseId, associationId },
    });
    if (!head) {
      this.logger.warn(
        `[SHOP] closing refused: purchase=${purchaseId.slice(0, 8)} is not a purchase of association=${associationId.slice(0, 8)}`
      );
      throw new NotFoundException('Purchase not found');
    }
    if (head.status !== 'paid_not_granted' || !head.userId) {
      throw this.purchaseNotClosable(head);
    }
    const grants = outcome === 'granted';
    const buyer = head.userId;
    let closed: PurchaseListRow;
    try {
      closed = await this.productRepo.manager.transaction(async (manager) => {
        if (grants) await this.lockBuyerTiers(manager, associationId, buyer);
        const record = await manager.findOne(PurchaseRecord, {
          where: { id: purchaseId, associationId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!record || record.status !== 'paid_not_granted') {
          throw this.purchaseNotClosable(record ?? head);
        }
        if ((await this.purchaseRecordService.closingsOf([record.id], manager)).has(record.id)) {
          throw this.purchaseAlreadyClosed(record.id);
        }
        if (grants) {
          // Read on the LOCKED row: an erasure committed while this waited has rewritten its buyer.
          const ctx = await this.closingContextOf(manager, associationId, [record]);
          const verdict = await this.closingGrantVerdict(record, ctx);
          if (verdict.refusal) throw this.closingGrantRefused(record.id, verdict);
          // What the manager confirmed must still be what happens: "nothing is granted" never grants.
          if (expectDelivered !== Boolean(verdict.deliveredTagId)) {
            throw this.closingChanged(record.id, expectDelivered);
          }
          if (verdict.deliveredTagId) {
            // Already delivered: nothing granted, nothing renewed. The tag is stamped with this
            // record, so the same delivery cannot close a second payment.
            const stamped = await this.userTagService.stampDelivery(
              verdict.deliveredTagId,
              record.id,
              manager
            );
            if (!stamped) {
              throw this.closingGrantRefused(record.id, {
                ...verdict,
                refusal: 'target-held',
                detail: 'its tag became the delivery of another payment',
              });
            }
            this.logger.log(
              `[SHOP] purchase=${record.id.slice(0, 8)}: tier ${verdict.variantKey ?? 'base'} already ` +
                `delivered (${verdict.detail}) - recorded granted, nothing granted`
            );
          } else {
            await this.grantClosedTier(manager, record, verdict.variantKey, closedBy);
          }
        }
        await manager.insert(PurchaseRecordClosing, {
          purchaseRecordId: record.id,
          outcome,
          closedByUserId: closedBy,
        });
        const [row] = await this.enrichPurchaseRecords([record], manager);
        return row;
      });
    } catch (err) {
      // The unique index answering a closing that slipped past the check above: still the 409. Only
      // THAT index: another unique violation in the transaction is not a second closing.
      if (violatesUniqueIndex(err, CLOSING_UNIQUE_INDEX))
        throw this.purchaseAlreadyClosed(purchaseId);
      throw err;
    }
    // The audit line of a money decision: who recorded which outcome for which payment.
    this.logger.log(
      `[SHOP] [AUDIT] purchase=${purchaseId.slice(0, 8)} paid and not granted CLOSED as ${outcome} ` +
        `by=${closedBy.slice(0, 8)} association=${associationId.slice(0, 8)} buyer=${buyer.slice(0, 8)}`
    );
    return closed;
  }

  /**
   * Whether a `paid_not_granted` record may be closed as `granted`, and which tier it would grant -
   * the ONE decision behind the closing (asked under the buyer's tier lock) and the purchases list
   * (asked without, as advice). In order:
   * - `buyer-erased`: the buyer is an erased account (`isErasedAccount`), a grant would make a
   *   cotisant of nobody;
   * - `tier-gone`: the tier paid for - a boutique record's product's `variantKey`, read now so a
   *   retag still matches, or a paid form's `cotisationVariantKey` - is no longer one the association
   *   sells (its product or form names none, the association has no mode, or the catalogue
   *   `grantCotisantWithin` validates against lacks it), so that grant never has to refuse;
   * - `year-over`: a `dated` association, and the payment's academic year (from `paidAt`) is not the
   *   current one - the tier it bought cannot be granted now;
   * - `target-held` / `not-a-rise` / `not-comparable`: ranked like a checkout (`tierRelationOf`, on
   *   the product prices) against what the buyer holds now: `held` is a renewal the payment did not
   *   buy - unless that tag is this payment's delivery (`deliveryOf`), which closes as `granted`
   *   with `deliveredTagId` set - `lower` would move the buyer down, `unranked` (a grid, a free amount or a named tier with no price on either side)
   *   cannot be told from a move down. `none` and `higher` grant.
   * - `held-tier-deleted`: `unranked` because the tier held is the tag of a DELETED tier (an orphan,
   *   no product): told apart from `not-comparable` because a repair exists - a roster grant of the
   *   tier swaps the orphan out, and this closing then finds its delivery.
   * `buyerTier` is read BEFORE any of these, so every refusal still says what the buyer holds.
   */
  private async closingGrantVerdict(
    record: PurchaseRecord,
    ctx: ClosingContext
  ): Promise<ClosingGrantVerdict> {
    const userId = record.userId;
    if (!userId || isErasedAccount(userId)) {
      // No account: no tier is held by anyone, and the list shows none.
      return {
        refusal: 'buyer-erased',
        variantKey: null,
        buyerTier: null,
        deliveredTagId: null,
        detail: 'its buyer account was erased',
      };
    }
    // What the buyer holds NOW is read first, so every refusal below still shows it.
    const { asso, catalogue } = ctx;
    const buyerTags = ctx.tagsByBuyer.get(userId) ?? [];
    const facts = asso
      ? await this.tierFactsFrom(
          asso,
          ctx.tiers,
          (tag) => buyerTags.some((t) => t.tagName === tag),
          ctx.orphansByBuyer.get(userId) ?? []
        )
      : null;
    const held = facts?.held ?? null;
    const buyerTier = held
      ? (catalogue.find((t) => t.variantKey === held.variantKey)?.name ?? held.variantKey ?? 'base')
      : null;
    const refused = (refusal: ClosingGrantRefusal, detail: string): ClosingGrantVerdict => ({
      refusal,
      variantKey: null,
      buyerTier,
      deliveredTagId: null,
      detail,
    });

    let variantKey: string | null;
    if (record.source === 'product') {
      const product = record.productId ? ctx.products.get(record.productId) : undefined;
      if (product?.type !== 'membership') return refused('tier-gone', 'its product names no tier');
      variantKey = product.variantKey;
    } else {
      const form = record.formId ? ctx.forms.get(record.formId) : undefined;
      if (!form?.grantsCotisation) return refused('tier-gone', 'its form grants no tier');
      variantKey = form.cotisationVariantKey;
    }
    const tierLabel = variantKey ?? 'base';
    if (!asso?.cotisationMode || !catalogue.some((t) => t.variantKey === variantKey)) {
      return refused('tier-gone', `tier ${tierLabel} is absent from the cotisation catalogue`);
    }
    if (
      asso.cotisationMode === 'dated' &&
      getAcademicYear(record.paidAt) !== getAcademicYear(new Date())
    ) {
      return refused('year-over', `paid in ${getAcademicYear(record.paidAt)}`);
    }
    const target = facts?.tiers.find((t) => t.variantKey === variantKey) ?? {
      variantKey,
      amountCents: null,
    };
    const relation = facts ? tierRelationOf(target, facts.heldKeys, held) : 'none';
    const against = `against the tier held (${held?.variantKey ?? 'base'})`;
    if (relation === 'held') {
      // Held BECAUSE this payment's tier was delivered since (`deliveryOf`): recorded `granted`.
      const tagName = catalogue.find((t) => t.variantKey === variantKey)?.tagName;
      const tag = buyerTags.find((t) => t.tagName === tagName);
      if (!tag) return refused('target-held', `tier ${tierLabel} is held under no readable tag`);
      const delivery = deliveryOf(
        tag,
        record,
        ctx.ownFormAnswer(record, tag.metadata?.submissionId)
      );
      if (delivery.delivered) {
        return {
          refusal: null,
          variantKey,
          buyerTier,
          deliveredTagId: tag.id,
          detail: delivery.detail,
        };
      }
      return refused('target-held', `the buyer holds tier ${tierLabel}: ${delivery.detail}`);
    }
    if (relation === 'lower') return refused('not-a-rise', `tier ${tierLabel} is lower ${against}`);
    if (relation === 'unranked' && held && held.product === null) {
      // A held tag of a DELETED tier (an orphan has no product): a manager's roster grant is the
      // repair - its sibling swap removes the orphan - after which this closing finds its delivery.
      return refused(
        'held-tier-deleted',
        `the buyer holds tier ${held.variantKey ?? 'base'}, which was deleted`
      );
    }
    if (relation === 'unranked') {
      return refused('not-comparable', `tier ${tierLabel} has no fixed price to rank ${against}`);
    }
    return { refusal: null, variantKey, buyerTier, deliveredTagId: null, detail: relation };
  }

  /**
   * Everything `closingGrantVerdict` reads, for `records` of association `associationId`, in a fixed
   * number of queries whatever their count: the association, its catalogue and tier products, the
   * records' products and forms, the buyers' ACTIVE tier tags, and - for form records - the buyers'
   * answers to those forms and how many paid records each buyer has per form. The closing loads it
   * for its one locked row, under the locks; the purchases list once for all its open rows.
   */
  private async closingContextOf(
    manager: EntityManager,
    associationId: string,
    records: PurchaseRecord[]
  ): Promise<ClosingContext> {
    const unique = <T>(xs: (T | null | undefined)[]) => [
      ...new Set(xs.filter((x): x is T => x != null)),
    ];
    const buyers = unique(records.map((r) => r.userId)).filter((u) => !isErasedAccount(u));
    const productIds = unique(records.map((r) => (r.source === 'product' ? r.productId : null)));
    const formRecords = records.filter((r) => r.source === 'form' && r.formId && r.userId);
    const formIds = unique(formRecords.map((r) => r.formId));
    const formBuyers = unique(formRecords.map((r) => r.userId));

    const asso = await manager.findOne(Association, { where: { id: associationId } });
    // Empty when the association no longer sells cotisations (no mode).
    const catalogue = await this.userTagService.listCotisationTiers(associationId, { manager });
    const tiers = asso?.cotisationMode
      ? await manager.find(AssociationProduct, {
          where: { associationId, type: 'membership' },
          select: TIER_RANK_COLUMNS,
        })
      : [];
    const products = productIds.length
      ? await manager.find(AssociationProduct, { where: { id: In(productIds), associationId } })
      : [];
    const forms: { id: string; grantsCotisation: boolean; cotisationVariantKey: string | null }[] =
      formIds.length
        ? await manager.query(
            `SELECT id, "grantsCotisation", "cotisationVariantKey" FROM forms
              WHERE id = ANY($1) AND "associationId" = $2`,
            [formIds, associationId]
          )
        : [];
    const tags = await this.userTagService.activeTagsOf(
      buyers,
      catalogue.map((t) => t.tagName),
      associationId,
      manager
    );
    // The form answers the buyers' tags name, by id: whose form and whose buyer each one is, is
    // decided below (`ownFormAnswer`), never by this read.
    const namedAnswers = unique(tags.map((t) => t.metadata?.submissionId)).filter(
      (id): id is string => typeof id === 'string' && isUUID(id)
    );
    const answers: { id: string; formId: string; userId: string | null }[] =
      formIds.length && namedAnswers.length
        ? await manager.query(
            `SELECT id::text AS id, "formId"::text AS "formId", "userId" FROM submissions
              WHERE id = ANY($1)`,
            [namedAnswers]
          )
        : [];
    // The buyer's PAID answers to each form, counted where they are settled - before fulfilment
    // writes the grant, then the record, apart and outside the tier lock - so an answer whose record
    // is not written yet is still counted.
    const paidAnswerCounts: { formId: string; userId: string; n: number }[] = formIds.length
      ? await manager.query(
          `SELECT "formId"::text AS "formId", "userId", count(*)::int AS n FROM submissions
            WHERE "formId" = ANY($1) AND "userId" = ANY($2)
              AND "paymentStatus" = ANY($3) AND "totalPaid" > 0
            GROUP BY 1, 2`,
          [formIds, formBuyers, PAID_ANSWER_STATUSES]
        )
      : [];
    const paidCounts: { formId: string; userId: string; n: number }[] = formIds.length
      ? await manager.query(
          `SELECT "formId"::text AS "formId", "userId", count(*)::int AS n FROM purchase_records
            WHERE source = 'form' AND "formId" = ANY($1) AND "userId" = ANY($2)
              AND status = ANY($3)
            GROUP BY 1, 2`,
          [formIds, formBuyers, RECEIVED_PURCHASE_STATUSES]
        )
      : [];

    const pair = (formId: string, userId: string) => `${formId}|${userId}`;
    const answersById = new Map(answers.map((a) => [a.id, a]));
    const paidCount = new Map(paidCounts.map((c) => [pair(c.formId, c.userId), c.n]));
    const paidAnswerCount = new Map(paidAnswerCounts.map((c) => [pair(c.formId, c.userId), c.n]));
    const tagsByBuyer = new Map<string, UserTag[]>();
    for (const t of tags) tagsByBuyer.set(t.userId, [...(tagsByBuyer.get(t.userId) ?? []), t]);
    const orphansByBuyer = await this.userTagService.heldOrphanTierTagsOf(
      buyers,
      associationId,
      catalogue,
      manager
    );
    return {
      asso,
      catalogue,
      tiers,
      products: new Map(products.map((p) => [p.id, p])),
      forms: new Map(forms.map((f) => [f.id, f])),
      tagsByBuyer,
      orphansByBuyer,
      ownFormAnswer: (record, submissionId) => {
        if (record.source !== 'form' || !record.formId || !record.userId) return false;
        if (typeof submissionId !== 'string') return false;
        const answer = answersById.get(submissionId);
        if (!answer) return false;
        const sameForm = answer.formId === record.formId;
        const sameBuyer = answer.userId === record.userId;
        const key = pair(record.formId, record.userId);
        const onlyPaidRecord = paidCount.get(key) === 1;
        // The stricter of the two: a paid answer whose record is not written yet still counts.
        const onlyPaidAnswer = paidAnswerCount.get(key) === 1;
        return sameForm && sameBuyer && onlyPaidRecord && onlyPaidAnswer;
      },
    };
  }

  /**
   * Grants, by hand, tier `variantKey` of a `paid_not_granted` record, inside the closing's
   * transaction and only after `closingGrantVerdict` allowed it under the buyer's tier lock: a first
   * tier or a rise. The manager's grant path (`grantCotisantWithin`): the sibling XOR replaces the
   * tier held, which for a rise is the purpose.
   */
  private async grantClosedTier(
    manager: EntityManager,
    record: PurchaseRecord,
    variantKey: string | null,
    closedBy: string
  ): Promise<void> {
    await this.userTagService.grantCotisantWithin(
      manager,
      record.associationId,
      record.userId as string,
      closedBy,
      variantKey,
      {
        purchaseRecordId: record.id,
        paymentIntentId: record.stripePaymentIntentId,
        manualGrant: true,
      }
    );
    this.logger.log(
      `[SHOP] purchase=${record.id.slice(0, 8)}: tier ${variantKey ?? 'base'} granted by hand ` +
        `to user=${(record.userId as string).slice(0, 8)} by=${closedBy.slice(0, 8)}`
    );
  }

  /** The typed 409 of a `granted` closing `closingGrantVerdict` refused, logged. */
  private closingGrantRefused(purchaseId: string, verdict: ClosingGrantVerdict): ConflictException {
    const refusal = CLOSING_GRANT_REFUSALS[verdict.refusal as ClosingGrantRefusal];
    this.logger.warn(
      `[SHOP] closing refused (${refusal.code}): purchase=${purchaseId.slice(0, 8)} - ${verdict.detail}; ` +
        'only a refund can be recorded'
    );
    return new ConflictException(refusal);
  }

  /** The typed 409 of a `granted` closing whose delivered state is no longer the one confirmed. */
  private closingChanged(purchaseId: string, expectDelivered: boolean): ConflictException {
    this.logger.warn(
      `[SHOP] closing refused (${PURCHASE_CLOSING_CHANGED}): purchase=${purchaseId.slice(0, 8)} was ` +
        `confirmed as ${expectDelivered ? 'already delivered' : 'to grant'}, and no longer is - nothing written`
    );
    return new ConflictException({
      code: PURCHASE_CLOSING_CHANGED,
      message: 'This payment changed since the list was read: read it again before closing it.',
    });
  }

  /** The typed 409 of a closing asked of a record that is not marked `paid_not_granted`, logged. */
  private purchaseNotClosable(record: PurchaseRecord): ConflictException {
    this.logger.warn(
      `[SHOP] closing refused (${PURCHASE_NOT_CLOSABLE}): purchase=${record.id.slice(0, 8)} is ` +
        `${record.status}${record.userId ? '' : ' with no buyer account'}`
    );
    return new ConflictException({
      code: PURCHASE_NOT_CLOSABLE,
      message: 'Only a payment marked paid and not delivered can be closed.',
    });
  }

  /** The typed 409 of a second closing of one payment, logged. */
  private purchaseAlreadyClosed(purchaseId: string): ConflictException {
    this.logger.warn(
      `[SHOP] closing refused (${PURCHASE_ALREADY_CLOSED}): purchase=${purchaseId.slice(0, 8)} was already closed`
    );
    return new ConflictException({
      code: PURCHASE_ALREADY_CLOSED,
      message: 'The outcome of this payment was already recorded.',
    });
  }

  // ── Post-purchase ─────────────────────────────────────────────────────────

  /**
   * Called by core-service when a VERIFIED Lydia callback reports a product request CONFIRMED. A
   * TRIGGER ONLY: the order_ref names the ATTEMPT (`checkoutId`), found by its id - so an attempt
   * whose issuing call never stored its request ids is found too - and it must be an attempt of
   * THIS product. Two checks then refuse, at ERROR, before anything is read:
   * - `vendorToken`, the Business whose key verified the callback, must be the account the attempt
   *   was issued to (the row's `vendorToken` snapshot): an authentic callback of association A
   *   never settles B's attempt, whatever its order_ref says;
   * - `requestId` must not be ANOTHER request than the one the attempt stored. An attempt that
   *   stored none (its request/do answer was lost) takes this one BEFORE it is settled
   *   (`storeCallbackRequestId`), so the record, the tag and a top-up name the payment; one already
   *   paid without it is completed (`completePaidWithoutRequestId`).
   * The purchase is then settled exactly as the payer's return settles it - Lydia's state of the
   * attempt's own request, read by its uuid or its order_ref - with the row's product, buyer and
   * amount; nothing of the callback's amount crosses. Asked even of a CLOSED attempt: a payment
   * Canari saw closed is still money taken. Answers the status read, or `refused`; a failed read
   * answers `unreadable`, which core turns into the 503 Lydia retries.
   */
  async handlePurchaseCompleted(
    productId: string,
    checkoutId: string,
    requestId: string,
    vendorToken: string
  ): Promise<{ outcome: ProductCheckoutStatus | 'refused' | 'unreadable' }> {
    const row = await this.checkoutRepo.findOne({ where: { id: checkoutId } });
    if (!row || row.productId !== productId) {
      this.logger.error(
        `[SHOP] purchase callback for request ${requestId} REFUSED: ${
          row ? 'its attempt is of another product' : 'no stored attempt has that id'
        } (product=${productId.slice(0, 8)} checkout=${checkoutId.slice(0, 8)}) - nothing recorded`
      );
      return { outcome: 'refused' };
    }
    if (row.vendorToken !== vendorToken) {
      this.logger.error(
        `[SHOP] purchase callback for checkout ${row.id.slice(0, 8)} REFUSED: verified for a Business ` +
          `that is not the one it was issued to - nothing recorded`
      );
      return { outcome: 'refused' };
    }
    const stored = await this.storeCallbackRequestId(row, requestId);
    if (!stored) return { outcome: 'refused' };
    let status: ProductCheckoutStatus;
    if (row.status === 'paid') {
      this.logger.log(`[SHOP] purchase callback for checkout ${row.id.slice(0, 8)}: already paid`);
      status = 'paid';
    } else {
      try {
        status = await this.readAndApplyRequestState(row);
      } catch (err: unknown) {
        this.logger.error(
          `[SHOP] purchase callback for checkout ${row.id.slice(0, 8)}: its request could not be read ` +
            `at Lydia (${err instanceof Error ? err.message : String(err)}) - nothing recorded, Lydia may retry`
        );
        return { outcome: 'unreadable' };
      }
      this.logger.log(
        `[SHOP] purchase callback for checkout ${row.id.slice(0, 8)} settled as ${status}`
      );
    }
    // ALWAYS on a paid outcome, not only when this unlocked snapshot already said paid: the payer's
    // return may have settled the attempt with no id between that read and this settlement, which
    // then finds it paid and records nothing. A no-op once the record carries an id. A failure here
    // throws, so core answers Lydia a 5xx and the callback is retried.
    if (status === 'paid') await this.completePaidWithoutRequestId(row.id, requestId);
    return { outcome: status };
  }

  /**
   * Makes the attempt carry the numeric request id of a verified callback BEFORE it is settled, so
   * the purchase record, the tag and a top-up all name the payment - an attempt whose request/do
   * answer was lost holds none, and `request/state` never answers one. Conditional on the column
   * being NULL, so it never overwrites the id request/do stored. Returns false - logged at ERROR -
   * when the attempt carries ANOTHER request: an authentic callback of a request that is not this
   * attempt's settles nothing. Updates `row` in place.
   */
  private async storeCallbackRequestId(row: ProductCheckout, requestId: string): Promise<boolean> {
    if (row.requestId === requestId) return true;
    if (!row.requestId) {
      const { affected } = await this.checkoutRepo.update(
        { id: row.id, requestId: IsNull() },
        { requestId }
      );
      if (affected) {
        this.logger.log(
          `[SHOP] checkout ${row.id.slice(0, 8)}: request id ${requestId} stored from its verified callback`
        );
        row.requestId = requestId;
        return true;
      }
      const now = await this.checkoutRepo.findOne({ where: { id: row.id } });
      row.requestId = now?.requestId ?? null;
      if (row.requestId === requestId) return true;
    }
    this.logger.error(
      `[SHOP] purchase callback for request ${requestId} REFUSED: checkout ${row.id.slice(0, 8)} ` +
        `was issued as request ${row.requestId ?? 'none'} - nothing recorded`
    );
    return false;
  }

  /**
   * Refuses (409 `COTISATION_DISABLED`) a membership product whose association has no cotisation
   * mode, BEFORE any money is requested or recorded: `resolveGrantTag` derives no tag without one,
   * so the purchase would grant nothing. The checkout opening and the cash sale call it, under the
   * buyer's tier lock, on the association they re-read there.
   */
  private assertMembershipGrantable(
    asso: Pick<Association, 'id' | 'cotisationMode'>,
    product: Pick<AssociationProduct, 'id' | 'type'>
  ): void {
    if (product.type !== 'membership' || asso.cotisationMode) return;
    this.logger.warn(
      `[SHOP] refused (${COTISATION_DISABLED}): membership product=${product.id.slice(0, 8)} of ` +
        `assoc=${asso.id.slice(0, 8)}, whose cotisations are disabled`
    );
    throw new ConflictException({
      code: COTISATION_DISABLED,
      message: "This association's cotisations are disabled: the product cannot be sold.",
    });
  }

  /**
   * Resolves the tag name and expiry to grant for a product purchase.
   * Returns null for non-membership products or membership products with no tag configured.
   * For an association with an active cotisation mode, the tag is derived fresh from the current
   * academic year and the product's `variantKey` (see `deriveCotisationTag`), so a purchase always
   * grants the current period's tier-specific tag even when the stored product tag has not been
   * re-provisioned since the last yearly rollover. An association WITHOUT a cotisation mode grants
   * nothing: its stored tag string is never granted as typed, since only a derived tier tag may be
   * issued (a membership product requires a mode to be created).
   */
  private async resolveGrantTag(
    product: AssociationProduct,
    manager: EntityManager
  ): Promise<{ tagName: string; expiresAt: Date | null } | null> {
    if (product.type !== 'membership' || !product.grantedTagName) return null;
    const asso = await manager.findOne(Association, { where: { id: product.associationId } });
    if (asso?.cotisationMode) {
      return deriveCotisationTag(asso.slug, asso.cotisationMode, new Date(), product.variantKey);
    }
    this.logger.warn(
      `[SHOP] membership product=${product.id.slice(0, 8)} of an association with no cotisation mode - no tag granted`
    );
    return null;
  }

  /**
   * Grants the tag a purchase of `product` carries, if any, inside the caller's transaction - the
   * cash grant's and the online settlement's - and drops the buyer's sibling tiers in the same one
   * (XOR), so a switch never leaves two forfaits held at once. `manualGrant` says how the purchase
   * was paid (by hand, or online), never inferred from a missing payment id: an online payment
   * settled before its request id was known is still an online payment.
   */
  private async grantPurchaseTag(
    manager: EntityManager,
    product: AssociationProduct,
    userId: string,
    grantedBy: string,
    paymentIntentId: string | null,
    manualGrant: boolean
  ): Promise<boolean> {
    const grant = await this.resolveGrantTag(product, manager);
    if (!grant) {
      if (product.type !== 'membership') return true;
      // A membership product that resolves to no tag grants nothing for the money taken: the
      // caller records the payment `paid_not_granted`, the durable marker the reports read.
      this.logger.error(
        `[SHOP] membership product=${product.id.slice(0, 8)} resolves to no tag - payment by ` +
          `user=${userId.slice(0, 8)} recorded paid but NOT granted; a refund or a grant is owed`
      );
      return false;
    }
    await this.userTagService.grantOrRenew(
      {
        userId,
        tagName: grant.tagName,
        issuingAssocId: product.associationId,
        grantedBy,
        expiresAt: grant.expiresAt,
        metadata: {
          productId: product.id,
          paymentIntentId,
          manualGrant,
        },
      },
      manager
    );
    this.logger.log(`[SHOP] tag "${grant.tagName}" granted to user=${userId.slice(0, 8)}`);
    await this.userTagService.revokeSiblingTierTags(
      product.associationId,
      userId,
      product.variantKey,
      manager
    );
    return true;
  }

  /**
   * A purchase recorded by hand (a cash grant): the tag and the purchase record in ONE transaction.
   * The online path is `settlePaidCheckout`, which records from a stored attempt.
   */
  private async fulfillProductPurchase(params: {
    product: AssociationProduct;
    userId: string;
    amountCents: number;
    paymentMethod: PurchasePaymentMethod;
    stripePaymentIntentId: string | null;
    grantedBy: string;
  }): Promise<PurchaseRecord> {
    const { product, userId, amountCents, paymentMethod, stripePaymentIntentId, grantedBy } =
      params;
    return this.productRepo.manager.transaction(async (manager) => {
      // A cash sale grants and swaps tiers like a settlement: the same lock, so the two cannot
      // interleave for one buyer. A manager's sale is not ranked - it may be a deliberate downgrade.
      await this.lockBuyerTiers(manager, product.associationId, userId);
      // Re-read after the locks: a retag committed while this sale waited renamed the tier's tag.
      const current =
        (await manager.findOne(AssociationProduct, { where: { id: product.id } })) ?? product;
      // Read after the locks too: cotisations disabled meanwhile refuse the sale, nothing recorded.
      if (current.type === 'membership') {
        const asso = await manager.findOne(Association, { where: { id: product.associationId } });
        if (!asso) throw new NotFoundException('Association not found');
        this.assertMembershipGrantable(asso, current);
      }
      const granted = await this.grantPurchaseTag(
        manager,
        current,
        userId,
        grantedBy,
        stripePaymentIntentId,
        paymentMethod !== 'online'
      );
      return this.purchaseRecordService.create(
        {
          userId,
          source: 'product',
          productId: product.id,
          amountCents,
          paymentMethod,
          status: receivedStatus(granted),
          stripePaymentIntentId,
          associationId: product.associationId,
          productName: product.name,
        },
        manager
      );
    });
  }

  // ── Cercle webhook ────────────────────────────────────────────────────────

  /**
   * Sends one signed request, and says why it failed.
   *
   * The payload and the signature are built HERE rather than once per dispatch, so every attempt -
   * including a retry days later - carries a fresh timestamp and is signed with the secret the
   * product holds NOW. That is what makes fixing a wrong `webhookUrl` or a rotated secret and
   * pressing retry work at all.
   *
   * @returns null when delivered, otherwise the error to record
   */
  private async sendCercleWebhook(
    product: AssociationProduct,
    delivery: WebhookDelivery
  ): Promise<string | null> {
    const payload = JSON.stringify({
      productId: product.id,
      userId: delivery.userId,
      amountCents: delivery.amountCents,
      paymentIntentId: delivery.paymentIntentId,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac('sha256', product.webhookSecret).update(payload).digest('hex');

    try {
      await firstValueFrom(
        this.httpService.post(product.webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Canari-Signature': `sha256=${signature}`,
          },
          timeout: 10_000,
          maxRedirects: 0,
          validateStatus: (s) => s >= 200 && s < 300,
        })
      );

      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : '[unknown error]';
    }
  }

  /** When the scheduler should try this row again, or null once the ladder is exhausted. */
  private nextAutoRetryAt(autoRetryCount: number): Date | null {
    const backoff = CERCLE_AUTO_RETRY_BACKOFF[autoRetryCount];

    return backoff === undefined ? null : new Date(Date.now() + backoff);
  }

  /**
   * Runs a ladder of attempts against ONE delivery row, updating it in place.
   *
   * `delays[0]` is not waited: the first attempt of any ladder happens immediately.
   *
   * @returns whether the Cercle accepted it
   */
  private async runDeliveryAttempts(
    product: AssociationProduct,
    delivery: WebhookDelivery,
    delays: number[]
  ): Promise<boolean> {
    let lastError = '';

    for (let i = 0; i < delays.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
      // Accumulated, not assigned: `attemptCount` is how many times this top-up has been sent in
      // total, across the initial dispatch and every retry since.
      delivery.attemptCount += 1;
      delivery.lastAttemptAt = new Date();

      const error = await this.sendCercleWebhook(product, delivery);
      if (error === null) {
        delivery.status = 'delivered';
        delivery.lastError = null;
        delivery.nextAttemptAt = null;
        await this.deliveryRepo.save(delivery);
        this.logger.log(
          `[CERCLE] webhook delivered: product=${product.id.slice(0, 8)} intent=${delivery.paymentIntentId} attempts=${delivery.attemptCount}`
        );

        return true;
      }

      lastError = error;
      this.logger.warn(`[CERCLE] webhook attempt ${delivery.attemptCount} failed: ${lastError}`);
    }

    delivery.status = 'failed';
    delivery.lastError = lastError;
    delivery.nextAttemptAt = this.nextAutoRetryAt(delivery.autoRetryCount);
    await this.deliveryRepo.save(delivery);
    this.logger.error(
      `[CERCLE] delivery failed for intent=${delivery.paymentIntentId}: ${
        delivery.nextAttemptAt
          ? `next automatic attempt at ${delivery.nextAttemptAt.toISOString()}`
          : 'automatic retries exhausted, needs a human'
      }`
    );

    return false;
  }

  /**
   * Dispatches a signed Cercle balance_topup webhook with up to 3 immediate delivery attempts.
   * Records ONE `webhook_deliveries` row, which every later retry updates rather than duplicates.
   */
  async dispatchCercleWebhook(
    product: AssociationProduct,
    userId: string,
    amountCents: number,
    paymentIntentId: string
  ): Promise<void> {
    const delivery = await this.deliveryRepo.save(
      this.deliveryRepo.create({
        productId: product.id,
        userId,
        amountCents,
        paymentIntentId,
        status: 'pending',
        // Set here rather than left to the column defaults: `runDeliveryAttempts` increments them,
        // and `undefined + 1` is NaN - which reads as a row that has never been tried.
        attemptCount: 0,
        autoRetryCount: 0,
      })
    );

    await this.runDeliveryAttempts(product, delivery, CERCLE_RETRY_DELAYS);
  }

  // ── Webhook delivery admin ────────────────────────────────────────────────

  /**
   * Lists all failed Cercle webhook deliveries for an association's products.
   *
   * Enriched with the member's name and the product's: a delivery row carries a user uuid and a
   * product uuid, and neither tells an admin whose top-up is stuck - which is the first thing they
   * need in order to decide between retrying, settling it by hand, and dropping the row.
   */
  async listWebhookFailures(associationId: string): Promise<FailedDelivery[]> {
    const products = await this.productRepo.find({
      where: { associationId },
      select: { id: true, name: true },
    });
    if (products.length === 0) return [];

    const productNames = new Map(products.map((p) => [p.id, p.name]));
    const deliveries = await this.deliveryRepo
      .createQueryBuilder('d')
      .where('d.productId IN (:...ids)', { ids: [...productNames.keys()] })
      .andWhere("d.status = 'failed'")
      .orderBy('d.createdAt', 'DESC')
      .getMany();

    if (deliveries.length === 0) return [];

    const userIds = [...new Set(deliveries.map((d) => d.userId))];
    const rows: { id: string; firstName: string | null; lastName: string | null }[] =
      await this.deliveryRepo.manager.query(
        `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
        [userIds]
      );
    const names = new Map(rows.map((r) => [r.id, r]));

    return deliveries.map((d) => ({
      id: d.id,
      productId: d.productId,
      productName: productNames.get(d.productId) ?? null,
      userId: d.userId,
      // Null rather than a placeholder: a delivery whose user no longer exists is a different
      // problem from one whose user is simply not on the Cercle yet, and the UI must be able to
      // tell them apart.
      firstName: names.get(d.userId)?.firstName ?? null,
      lastName: names.get(d.userId)?.lastName ?? null,
      amountCents: d.amountCents,
      paymentIntentId: d.paymentIntentId,
      status: d.status,
      attemptCount: d.attemptCount,
      autoRetryCount: d.autoRetryCount,
      lastAttemptAt: d.lastAttemptAt ? d.lastAttemptAt.toISOString() : null,
      nextAttemptAt: d.nextAttemptAt ? d.nextAttemptAt.toISOString() : null,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /**
   * Retries a failed webhook delivery, ONCE.
   *
   * One attempt rather than the three-step ladder the initial dispatch runs: that ladder sleeps 5 s
   * then 15 s between attempts, each with a 10 s timeout, so the admin's request could hang for the
   * better part of a minute and time out at the proxy - which is one of the two reasons this button
   * looked dead. The other was that it inserted a NEW row instead of updating this one, so the
   * failure it was pressed on stayed in the list whatever happened.
   *
   * The product is resolved through `associationId` as well, not by the delivery id alone:
   * `MANAGE_PRODUCTS` is granted per association, so an unscoped lookup would let an admin of any
   * association re-fire another one's top-up.
   */
  async retryWebhookDelivery(associationId: string, deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const product = await this.productRepo.findOne({
      where: { id: delivery.productId, associationId },
    });
    if (!product) throw new NotFoundException('Webhook delivery not found');
    if (!product.webhookUrl || !product.webhookSecret) {
      throw new BadRequestException('Product webhook not configured');
    }

    // A manual retry means an admin changed something, so the automatic ladder starts over rather
    // than resuming at a 24 h step - or staying exhausted forever.
    delivery.autoRetryCount = 0;
    this.logger.log(
      `[CERCLE] manual retry of delivery ${deliveryId.slice(0, 8)} intent=${delivery.paymentIntentId}`
    );
    await this.runDeliveryAttempts(product, delivery, [0]);

    return delivery;
  }

  /**
   * Re-sends every failed delivery whose backoff has elapsed. Driven by the scheduler.
   *
   * The product is re-read for each row, so a corrected `webhookUrl` or a rotated secret is picked
   * up without anyone touching the delivery. A row whose product lost its webhook configuration is
   * taken OFF the ladder rather than retried into the void.
   *
   * @returns how many were delivered, out of how many were due
   */
  async retryDueWebhookDeliveries(): Promise<{ delivered: number; attempted: number }> {
    const due = await this.deliveryRepo
      .createQueryBuilder('d')
      .where("d.status = 'failed'")
      .andWhere('d.nextAttemptAt IS NOT NULL')
      .andWhere('d.nextAttemptAt <= :now', { now: new Date() })
      .orderBy('d.nextAttemptAt', 'ASC')
      .take(CERCLE_AUTO_RETRY_BATCH)
      .getMany();

    if (due.length === 0) return { delivered: 0, attempted: 0 };

    this.logger.log(`[CERCLE] ${due.length} failed deliveries due for an automatic retry`);

    let delivered = 0;
    for (const delivery of due) {
      const product = await this.productRepo.findOne({ where: { id: delivery.productId } });
      if (!product?.webhookUrl || !product.webhookSecret) {
        delivery.nextAttemptAt = null;
        delivery.lastError = 'Product webhook is not configured';
        await this.deliveryRepo.save(delivery);
        this.logger.warn(
          `[CERCLE] delivery ${delivery.id.slice(0, 8)} taken off the ladder: no webhook configured`
        );
        continue;
      }

      // Counted BEFORE the attempt, so a crash mid-retry cannot leave the row looping on the same
      // backoff step forever.
      delivery.autoRetryCount += 1;
      if (await this.runDeliveryAttempts(product, delivery, [0])) {
        delivered += 1;
      }
    }

    return { delivered, attempted: due.length };
  }

  /**
   * Drops a failed delivery from the audit list. The case this exists for: the top-up was settled
   * by hand on the Cercle side, so retrying would credit it twice and the row has nothing left to
   * say. Scoped to the association like the retry, and refuses anything but a `failed` row - a
   * delivered one is the record of a credit that really happened.
   */
  async deleteWebhookDelivery(associationId: string, deliveryId: string): Promise<void> {
    const delivery = await this.deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    const product = await this.productRepo.findOne({
      where: { id: delivery.productId, associationId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Webhook delivery not found');
    if (delivery.status !== 'failed') {
      throw new BadRequestException('Only a failed delivery can be deleted');
    }

    await this.deliveryRepo.remove(delivery);
    this.logger.log(
      `[CERCLE] deleted failed delivery ${deliveryId.slice(0, 8)} intent=${delivery.paymentIntentId}`
    );
  }
}
