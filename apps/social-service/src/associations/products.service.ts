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
  PREVIOUS_CHECKOUT_OPEN,
  PRODUCT_ALREADY_PURCHASED,
  PRODUCT_REQUEST_LIFETIME_SECONDS,
  productOrderRef,
  withCheckoutReturnKey,
} from './product-checkout';
import { LYDIA_REQUEST_UUID_RE, toRequestState } from '../forms/seat-hold';
import { isUniqueViolation } from '../common/pg-errors';
import { Association } from './entities/association.entity';
import { AssociationsService } from './associations.service';
import { UserTagService } from '../users/user-tag.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import {
  PurchaseRecord,
  type PurchasePaymentMethod,
} from '../users/entities/purchase-record.entity';
import { resolveCheckoutCallbackUrl } from '../common/checkout-callback-url';
import { CreateProductDto, GrantProductPurchaseDto, UpdateProductDto } from './dto/association.dto';
import {
  type CotisationMode,
  deriveCotisationTag,
  tierVariantKeys,
  variantKeyCap,
  variantKeyFromLabel,
} from './cotisation-tag.util';
import { lockAssociationTiers } from './association-tier-lock';
import {
  isDelegating,
  resolvePaymentTarget,
  fetchActivePaymentProvider,
  type PaymentTarget,
} from './payment-delegation.util';
import { PricingFactsService } from '../pricing/pricing-facts.service';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import {
  amountOutOfRange,
  coreRefusedRequest,
  mapCorePaymentError,
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
};

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

/** The answer for a product with no grid: its own columns price it, exactly as before. */
const FIXED_PRICE: ViewerPrice = { kind: 'fixed', amountCents: null, dependsOnProfile: false };

/**
 * A product as returned to a client: the Cercle HMAC key is replaced by a boolean saying whether
 * one is set. The admin page needs to know that a webhook is configured; nobody outside this
 * service needs the key itself.
 */
export type SafeProduct = AssociationProduct & { webhookConfigured: boolean };

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
    const [provider, parent] = await Promise.all([
      fetchActivePaymentProvider(this.httpService),
      isDelegating(asso)
        ? this.assoRepo.findOne({ where: { id: asso.paymentParentAssociationId } })
        : Promise.resolve(null),
    ]);
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
  private async resolveGridPrice(
    matrix: PriceMatrix,
    userId: string,
    associationId: string
  ): Promise<CellValue> {
    const facts = await this.pricingFacts.build({
      userId,
      associationId,
      needProfile: dimensionsNeedProfile(matrix.dimensions),
    });
    return resolveCellPrice(matrix, facts, 'product');
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
    statusByAssoc: Map<string, { isCotisant: boolean; activeTier: string | null }>
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

  /** The release itself, for an association already loaded (see `releaseWithheldProducts`). */
  private async releaseWithheldFor(asso: Association): Promise<number> {
    const associationId = asso.id;
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    if (!paymentTarget.ready) {
      this.logger.debug(
        `[SHOP] nothing released for association=${associationId.slice(0, 8)}: payment target not ready ` +
          `(provider=${paymentTarget.provider} delegated=${paymentTarget.delegated})`
      );
      return 0;
    }

    const { affected } = await this.productRepo.update(
      { associationId, activationWithheld: true },
      { isActive: true, activationWithheld: false }
    );
    const count = affected ?? 0;
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
    const children = await this.assoRepo.find({
      where: { paymentParentAssociationId: associationId, paymentDelegationStatus: 'approved' },
      select: { id: true },
    });
    let total = await this.releaseWithheldProducts(associationId);
    for (const child of children) {
      // One failing club must not stop the others: this runs after a state change that is already
      // committed, so a throw here would lose every release queued behind it.
      try {
        total += await this.releaseWithheldProducts(child.id);
      } catch (e) {
        this.logger.error(
          `[SHOP] release FAILED for delegating child=${child.id.slice(0, 8)} of ` +
            `parent=${associationId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return total;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Returns all active products across all associations (login required, listed on /shop), each
   * annotated with `viewerIsCotisant`/`viewerActiveTier` for `userId` so the client can gate/label
   * members-only products without mirroring the cotisation-tag derivation, and with `viewerPrice`
   * - what a gridded product costs THIS viewer, since a grid rests on facts a browser has no way
   * to evaluate.
   */
  async listAllActive(userId: string): Promise<ShopProduct[]> {
    const products = await this.productRepo.find({
      where: { isActive: true },
      order: { associationId: 'ASC', sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const statusByAssoc = await this.cotisantStatusFor(userId, [
      ...new Set(products.map((p) => p.associationId)),
    ]);
    const viewerPrices = await this.viewerPricesFor(products, userId, statusByAssoc);
    return products.map((p) => {
      const status = statusByAssoc.get(p.associationId);
      return this.toSafeProduct({
        ...p,
        viewerIsCotisant: status?.isCotisant ?? false,
        viewerActiveTier: status?.activeTier ?? null,
        viewerPrice: viewerPrices.get(p.id) ?? FIXED_PRICE,
      });
    });
  }

  /**
   * Given a user and a set of association ids, returns per-association cotisation status: whether
   * the user holds ANY active tier tag for it (`isCotisant`, back-compat `membersOnly`/generic
   * semantics - see `isBuyerCotisant`), and which specific tier (`variantKey`) they currently hold,
   * if any (`activeTier`, WP-COT-3). Loads each association's tiered products and the user's active
   * tags once, so annotating N products costs a fixed number of queries regardless of product count.
   */
  private async cotisantStatusFor(
    userId: string,
    assocIds: string[]
  ): Promise<Map<string, { isCotisant: boolean; activeTier: string | null }>> {
    const result = new Map<string, { isCotisant: boolean; activeTier: string | null }>();
    if (assocIds.length === 0) return result;
    const [assos, tierProducts, activeTags] = await Promise.all([
      this.assoRepo.find({
        where: { id: In(assocIds) },
        select: { id: true, slug: true, cotisationMode: true },
      }),
      // Every tier, on sale or not: `isActive` gates BUYING a forfait, never recognizing the one
      // a user already holds (see `listCotisationTiers`).
      this.productRepo.find({
        where: { associationId: In(assocIds), type: 'membership' },
        select: { associationId: true, variantKey: true },
      }),
      this.userTagService.listByUser(userId),
    ]);
    const activeTagNames = new Set(activeTags.map((t) => t.tagName));
    const tiersByAssoc = new Map<string, { variantKey: string | null }[]>();
    for (const p of tierProducts) {
      const list = tiersByAssoc.get(p.associationId) ?? [];
      list.push({ variantKey: p.variantKey });
      tiersByAssoc.set(p.associationId, list);
    }
    for (const asso of assos) {
      if (!asso.cotisationMode) continue;
      let isCotisant = false;
      let activeTier: string | null = null;
      for (const variantKey of tierVariantKeys(tiersByAssoc.get(asso.id) ?? [])) {
        const { tagName } = deriveCotisationTag(
          asso.slug,
          asso.cotisationMode,
          new Date(),
          variantKey
        );
        if (activeTagNames.has(tagName)) {
          isCotisant = true;
          activeTier = variantKey;
          break;
        }
      }
      result.set(asso.id, { isCotisant, activeTier });
    }
    return result;
  }

  /**
   * Returns active products for a single association ordered by sortOrder, each carrying what the
   * caller would pay (`viewerPrice`).
   *
   * `userId` is OPTIONAL because this listing is the public association page, read while logged
   * out as often as not. A guest has no promo, no formation and no forfait, so a grid resolves
   * them to its "everyone else" cell - an answer, not a failure, and `dependsOnProfile` is what
   * lets the page say the figure may change once they sign in.
   */
  async listByAssoc(associationId: string, userId?: string): Promise<SafeProduct[]> {
    const products = await this.productRepo.find({
      where: { associationId, isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const statusByAssoc = userId
      ? await this.cotisantStatusFor(userId, [associationId])
      : new Map<string, { isCotisant: boolean; activeTier: string | null }>();
    const viewerPrices = await this.viewerPricesFor(products, userId, statusByAssoc);
    return products.map((p) =>
      this.toSafeProduct({ ...p, viewerPrice: viewerPrices.get(p.id) ?? FIXED_PRICE })
    );
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
        const derived = deriveCotisationTag(
          asso.slug,
          asso.cotisationMode,
          new Date(),
          rest.variantKey ?? null
        );
        grantedTagName = derived.tagName;
        tagExpiresAt = derived.expiresAt;
      }
    }

    // A grid is validated against the association's own tiers, so it is parsed here rather than
    // by a decorator - and a refusal is a price somebody would not have had.
    const { priceMatrix: rawMatrix, ...withoutMatrix } = rest;
    const priceMatrix = await this.parseProductMatrix(associationId, rawMatrix);

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
   * lock: the sibling keys are read and the row inserted in ONE transaction, every read on its
   * manager, so two concurrent creates of the same label get distinct keys (the second waits for
   * the first to commit, then sees its row). Everything that may call another service ran before.
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
      const key = variantKeyFromLabel(
        name,
        siblings.map((p) => p.variantKey ?? null),
        variantKeyCap(slug)
      );
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

    const retagging =
      product.type === 'membership' &&
      dto.variantKey !== undefined &&
      (dto.variantKey ?? null) !== product.variantKey
        ? await this.planTierRetag(product, dto.variantKey ?? null)
        : null;

    // `priceMatrix` is resolved above and deliberately kept out of the blanket assign: the DTO
    // holds the RAW document a client sent, and copying it over the parsed one would store a grid
    // nothing validated.
    const { priceMatrix: _rawMatrix, ...assignable } = dto;
    Object.assign(product, assignable, { currency: 'eur' });
    // Same rule as on creation, and it also repairs a top-up product created before it existed:
    // saving the product from /admin/cercle is enough to make it repeatable and unlimited again.
    if (product.type === 'balance_topup') {
      product.allowRepeatPurchase = true;
      product.maxPurchasesPerUser = null;
      product.maxPurchasesTotal = null;
    }
    if (!retagging) return this.toSafeProduct(await this.productRepo.save(product));

    product.grantedTagName = retagging.newTagName;
    product.tagExpiresAt = retagging.newExpiresAt;
    // Renaming the tier's tag and the tags already granted under it must be one transaction:
    // half-applied, every cotisant of this tier silently stops being one.
    return this.productRepo.manager.transaction(async (manager) => {
      const saved = await manager.save(AssociationProduct, product);
      const result: { affected?: number | null } = await manager
        .createQueryBuilder()
        .update('user_tags')
        .set({ tagName: retagging.newTagName, expiresAt: retagging.newExpiresAt })
        .where('"issuingAssocId" = :assocId AND "tagName" = :oldTag', {
          assocId: product.associationId,
          oldTag: retagging.oldTagName,
        })
        .execute();
      this.logger.log(
        `[COTISATION] retagged tier ${product.id.slice(0, 8)}: "${retagging.oldTagName}" -> "${retagging.newTagName}" (${result.affected ?? 0} cotisant tag(s) migrated)`
      );
      return this.toSafeProduct(saved);
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
    newVariantKey: string | null
  ): Promise<{ oldTagName: string; newTagName: string; newExpiresAt: Date | null }> {
    const asso = await this.assoRepo.findOne({ where: { id: product.associationId } });
    if (!asso?.cotisationMode) {
      throw new BadRequestException('Cotisation must be enabled to change a tier');
    }
    await this.assertVariantKeyFree(product.associationId, newVariantKey, product.id);

    const now = new Date();
    const oldTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, product.variantKey);
    const newTag = deriveCotisationTag(asso.slug, asso.cotisationMode, now, newVariantKey);
    return {
      oldTagName: oldTag.tagName,
      newTagName: newTag.tagName,
      newExpiresAt: newTag.expiresAt,
    };
  }

  /**
   * Throws when another membership product of the association already claims `variantKey`.
   * Two tiers sharing a key would derive the same tag, making the forfait a coin flip: the XOR
   * revoke, the roster label and `cotisant-status` would each pick whichever row they saw first.
   */
  private async assertVariantKeyFree(
    associationId: string,
    variantKey: string | null,
    exceptProductId?: string
  ): Promise<void> {
    const siblings = await this.productRepo.find({
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
   * a multi-tier association is exactly what this DOES allow (WP-COT-11).
   */
  async delete(associationId: string, productId: string): Promise<void> {
    const product = await this.productRepo.findOne({
      where: { id: productId, associationId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.type === 'membership') {
      const asso = await this.assoRepo.findOne({ where: { id: associationId } });
      const remaining = await this.productRepo.count({
        where: { associationId, type: 'membership' },
      });
      if (asso?.cotisationMode && remaining <= 1) {
        throw new BadRequestException(
          'Cannot delete the last cotisation tier while cotisations are enabled'
        );
      }
    }
    await this.productRepo.remove(product);
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
    await this.settlePreviousOpenAttempt(productId, userId);

    const { product, amountCents, paymentTarget, vendorToken } = await this.resolvePurchase(
      associationId,
      productId,
      userId,
      customAmountCents
    );

    let checkout: ProductCheckout;
    try {
      checkout = await this.checkoutRepo.save(
        this.checkoutRepo.create({
          productId: product.id,
          userId,
          associationId: product.associationId,
          paymentAssociationId: paymentTarget.targetAssociationId,
          vendorToken,
          amountCents,
          currency: product.currency,
          productName: product.name,
          requestUuid: null,
          requestId: null,
          status: 'open',
          expiresAt: new Date(Date.now() + PRODUCT_REQUEST_LIFETIME_SECONDS * 1000),
          settledAt: null,
          purchaseRecordId: null,
        })
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw this.checkoutInProgress(
          product.id,
          userId,
          'another attempt was opened at the same time'
        );
      }
      throw err;
    }
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
      const vendorToken = open.vendorToken;
      if (open.requestId) {
        const { data } = await firstValueFrom(
          this.httpService.post<{ outcome?: string }>(
            coreUrl('payments/cancel-request'),
            { requestId: open.requestId, connectAccountId: vendorToken },
            internalCoreRequestConfig()
          )
        );
        if (data?.outcome === 'cancelled') {
          this.logger.log(
            `[SHOP] checkout ${open.id.slice(0, 8)}: request ${open.requestId} cancelled`
          );
          await this.closeCheckout(open, 'cancelled');
          return;
        }
        if (data?.outcome !== 'already-settled') {
          throw new Error(`unexpected cancel outcome ${JSON.stringify(data?.outcome)}`);
        }
      }
      const status = await this.readAndApplyRequestState(open);
      if (status !== 'open') return;
      unproven = 'the request is still open at the provider';
    } catch (err: unknown) {
      unproven = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= open.expiresAt.getTime() + CHECKOUT_EXPIRY_MARGIN_MS) {
      this.logger.error(
        `[SHOP] checkout ${open.id.slice(0, 8)} is past its expire_time and still unproven ` +
          `(${unproven}) - closed as expired so its buyer may retry; a payment taken before it ` +
          `expired is still recorded by its confirm callback`
      );
      await this.closeCheckout(open, 'expired');
      return;
    }
    throw this.previousCheckoutOpen(open.id, unproven);
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
   * Reads the attempt's request at Lydia (`payments/request-state`) and writes what it says. The
   * request is named by the row's own uuid, or - for an attempt whose issuing call never answered
   * one - by its order_ref (`productOrderRef`), which Lydia's `request/state` also finds.
   * `paid` is settled (`settlePaidCheckout`), `declined` (state 5) and `cancelled-or-expired`
   * (state 6: `expired` past the row's `expiresAt`, `cancelled` before it - the state alone cannot
   * tell them apart) close the row, `not-found` on an order_ref lookup (no request carries it:
   * request/do never reached Lydia) closes it `cancelled`, `open` and `unknown` change nothing.
   * Returns the status the row now has, as far as this call knows. A failed read throws. The read
   * goes to the Business the request was issued to (the row's `vendorToken` snapshot).
   */
  private async readAndApplyRequestState(row: ProductCheckout): Promise<ProductCheckoutStatus> {
    const byUuid = !!row.requestUuid && LYDIA_REQUEST_UUID_RE.test(row.requestUuid);
    const { data } = await firstValueFrom(
      this.httpService.post<{ state?: string; raw?: string }>(
        coreUrl('payments/request-state'),
        byUuid
          ? { sessionId: row.requestUuid, connectAccountId: row.vendorToken }
          : { orderRef: productOrderRef(row.productId, row.id), connectAccountId: row.vendorToken },
        internalCoreRequestConfig()
      )
    );
    this.logger.debug(
      `[SHOP] checkout ${row.id.slice(0, 8)}: read by ${byUuid ? 'uuid' : 'order_ref'} -> ${data?.state}`
    );
    // `not-found` is not a request state but the answer of an order_ref LOOKUP that matched no
    // request: request/do never reached Lydia. Read before the one typed mapping of the states.
    if (data?.state === 'not-found' && !byUuid) {
      this.logger.warn(
        `[SHOP] checkout ${row.id.slice(0, 8)}: Lydia holds no request with order_ref ${productOrderRef(row.productId, row.id)} - never issued, closed cancelled`
      );
      return this.closeCheckout(row, 'cancelled');
    }
    const state = toRequestState(data?.state);
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
      `[SHOP] checkout ${row.id.slice(0, 8)}: request in a state nothing here reads (${data?.raw ?? JSON.stringify(data?.state)}) - left ${row.status}`
    );
    return row.status;
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
      if (product) {
        await this.grantPurchaseTag(manager, product, row.userId, 'system', paymentIntentId, false);
      } else {
        this.logger.error(
          `[SHOP] checkout ${row.id.slice(0, 8)}: product ${row.productId.slice(0, 8)} no longer exists - the purchase is recorded, no tag granted`
        );
      }
      const record = await this.purchaseRecordService.create(
        {
          userId: row.userId,
          source: 'product',
          productId: row.productId,
          amountCents: row.amountCents,
          paymentMethod: 'online',
          status: 'paid',
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
      return { row, product, paymentIntentId };
    });

    if (!outcome?.product) return;
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
      message: 'A checkout of this product is already being opened.',
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
        'The previous payment request for this product is still open. Try again once it has expired, at most 35 minutes after it was started.',
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
   * Loads product/association, validates purchase rules, and resolves the amount in cents.
   */
  private async resolvePurchase(
    associationId: string,
    productId: string,
    userId: string,
    customAmountCents?: number
  ): Promise<{
    asso: Association;
    product: AssociationProduct;
    amountCents: number;
    paymentTarget: PaymentTarget;
    /** The paying Business's `vendor_token`: never null once the purchase is allowed. */
    vendorToken: string;
  }> {
    const [asso, product] = await Promise.all([
      this.assoRepo.findOne({ where: { id: associationId } }),
      this.productRepo.findOne({ where: { id: productId, associationId } }),
    ]);

    if (!asso) throw new NotFoundException('Association not found');
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive) {
      throw new NotFoundException('Product not found or inactive');
    }

    // Route to the association's own account, or an approved parent's when delegating.
    const paymentTarget = await this.resolvePaymentTargetFor(asso);
    const vendorToken = paymentTarget.connectAccountId;
    if (!paymentTarget.ready || !vendorToken) {
      throw new BadRequestException(
        paymentTarget.delegated
          ? 'The parent association this club delegates payments to has not completed onboarding to receive payments'
          : 'Association has not completed onboarding to receive payments'
      );
    }

    const isCotisant = await this.isBuyerCotisant(asso, userId);
    await this.assertCanPurchase(product, userId, isCotisant);

    let amountCents: number;
    if (product.priceMatrix) {
      // A grid REPLACES the fixed pricing, it never layers on it: `amountCents`, `amountCentsMember`
      // and `memberPriceTag` decide nothing while one is set. Two mechanisms for "some people pay
      // less" would need an order between them, and an order that decides money is the priority
      // rule this whole design exists in order not to have.
      const cell = await this.resolveGridPrice(product.priceMatrix, userId, associationId);
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
      const qualifiesForMemberPrice = product.memberPriceTag
        ? await this.userTagService.hasActiveTag(userId, product.memberPriceTag)
        : isCotisant;
      if (qualifiesForMemberPrice && product.amountCentsMember != null) {
        amountCents = product.amountCentsMember;
        this.logger.debug(
          `[SHOP] member price applied: product=${product.id.slice(0, 8)} user=${userId.slice(0, 8)} amount=${amountCents}`
        );
      } else {
        amountCents = product.amountCents;
      }
    } else if (product.allowCustomAmount && customAmountCents !== undefined) {
      this.assertWithinCustomBounds(product, associationId, customAmountCents, 'custom amount');
      amountCents = customAmountCents;
    } else {
      throw new BadRequestException('No amount provided for this product');
    }

    return { asso, product, amountCents, paymentTarget, vendorToken };
  }

  /**
   * Lists all completed purchases for an association (boutique + paid forms).
   * Requires MANAGE_PRODUCTS on the association (enforced by controller).
   */
  async listAssociationPurchases(associationId: string): Promise<
    Array<{
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
    }>
  > {
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

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Achats');
    sheet.columns = [
      { header: 'Nom', key: 'lastName', width: 20 },
      { header: 'Prénom', key: 'firstName', width: 20 },
      { header: 'Type', key: 'source', width: 12 },
      { header: 'Produit', key: 'productName', width: 30 },
      { header: 'Montant', key: 'amount', width: 12, style: { numFmt: '0.00 "€"' } },
      { header: 'Paiement', key: 'paymentMethod', width: 12 },
      { header: 'Date', key: 'paidAt', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    ];

    purchases.forEach((p) => {
      sheet.addRow({
        // A guest (no account) is named as the responses table names one; the organiser finds the
        // person through the form's own answers ("Nom Prenom").
        lastName: p.lastName ?? (p.userId ? '' : 'Invité'),
        firstName: p.firstName ?? '',
        source: p.source === 'form' ? 'Formulaire' : 'Boutique',
        productName: p.productName,
        amount: p.amountCents / 100,
        // The sheet is French throughout, and this column says HOW rather than THROUGH WHOM:
        // 'Stripe' named the processor of the day, and the app's own label for the same fact
        // is `asso_achats_payment_online`.
        paymentMethod: p.paymentMethod === 'cash' ? 'Espèces' : 'En ligne',
        paidAt: new Date(p.paidAt),
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

  /** Attaches buyer display names to purchase records. */
  private async enrichPurchaseRecords(records: PurchaseRecord[]): Promise<
    Array<{
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
    }>
  > {
    // A guest's payment on a public form names no buyer (migration 103): nobody to look up.
    const userIds = [...new Set(records.map((r) => r.userId).filter((id) => id != null))];
    const nameMap = new Map<string, { firstName: string | null; lastName: string | null }>();
    if (userIds.length > 0) {
      const rows: { id: string; firstName: string | null; lastName: string | null }[] =
        await this.productRepo.manager.query(
          `SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [userIds]
        );
      rows.forEach((r) => nameMap.set(r.id, { firstName: r.firstName, lastName: r.lastName }));
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
      const tag = await this.userTagService.getActiveTag(userId, tagName);
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
    if (!asso.cotisationMode) return false;
    // All tiers, sellable or not - holding a withdrawn tier's tag still makes you a cotisant.
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
      if (await this.userTagService.hasActiveTag(userId, tagName)) return true;
    }
    return false;
  }

  /** Returns true when the user holds at least one of the given tag names. */
  private async hasAnyActiveTag(userId: string, tagNames: string[]): Promise<boolean> {
    for (const tagName of tagNames) {
      if (await this.userTagService.hasActiveTag(userId, tagName)) return true;
    }
    return false;
  }

  /** Enforces member-gating, per-user/global purchase limits, and membership renewal rules. */
  private async assertCanPurchase(
    product: AssociationProduct,
    userId: string,
    isCotisant: boolean
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
        ? !(await this.hasAnyActiveTag(userId, requiredTags))
        : product.membersOnly && !isCotisant;
    if (gateFailed) {
      this.logger.debug(
        `[SHOP] rejected: product=${product.id.slice(0, 8)} gating not satisfied for user=${userId.slice(0, 8)}`
      );
      throw new ForbiddenException(
        requiredTags.length > 0
          ? 'This product is reserved to users holding one of the required tags'
          : "This product is reserved to the association's cotisants"
      );
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
      product.id
    );

    if (product.maxPurchasesTotal != null) {
      const totalPaid = await this.purchaseRecordService.countPaidByProduct(product.id);
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
      const grant = await this.resolveGrantTag(product);
      if (grant) {
        const hasTag = await this.userTagService.hasActiveTag(userId, grant.tagName);
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
      amountCents = dto.amountCents;
    } else if (product.priceMatrix) {
      // The beneficiary is known, so their cell is known: falling back to `amountCents` here would
      // record a cash sale at a price the grid never quoted, and `amountCents` may not even be set.
      const cell = await this.resolveGridPrice(product.priceMatrix, dto.userId, associationId);
      if (cell === null) {
        throw new BadRequestException(
          'The pricing grid does not sell this product to that person, so there is no amount to record.'
        );
      }
      amountCents = cell;
    } else if (product.amountCents != null) {
      amountCents = product.amountCents;
    } else {
      throw new BadRequestException('amountCents is required for this product');
    }

    // Whenever the product takes a free amount - as the checkout does - so a max set with no min
    // still binds the grant.
    if (product.allowCustomAmount) {
      this.assertWithinCustomBounds(product, associationId, amountCents, 'cash grant amount');
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
   * Resolves the tag name and expiry to grant for a product purchase.
   * Returns null for non-membership products or membership products with no tag configured.
   * For an association with an active cotisation mode, the tag is derived fresh from the current
   * academic year and the product's `variantKey` (see `deriveCotisationTag`), so a purchase always
   * grants the current period's tier-specific tag even when the stored product tag has not been
   * re-provisioned since the last yearly rollover. Falls back to the product's stored tag for
   * membership products without a cotisation mode (arbitrary/legacy tags).
   */
  private async resolveGrantTag(
    product: AssociationProduct
  ): Promise<{ tagName: string; expiresAt: Date | null } | null> {
    if (product.type !== 'membership' || !product.grantedTagName) return null;
    const asso = await this.assoRepo.findOne({ where: { id: product.associationId } });
    if (asso?.cotisationMode) {
      return deriveCotisationTag(asso.slug, asso.cotisationMode, new Date(), product.variantKey);
    }
    return { tagName: product.grantedTagName, expiresAt: product.tagExpiresAt ?? null };
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
  ): Promise<void> {
    const grant = await this.resolveGrantTag(product);
    if (!grant) return;
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
      await this.grantPurchaseTag(
        manager,
        product,
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
          status: 'paid',
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
