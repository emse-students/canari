import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FILE_RETENTION_MAX_DAYS,
  FILE_RETENTION_MIN_DAYS,
  FORM_ITEM_ID_MAX_LENGTH,
} from '../form-files.service';
import { SUPPORTED_QUESTION_TYPES } from './question-types';
import { QUESTION_IMAGE_ALT_MAX_LENGTH, QUESTION_IMAGE_URL_RE } from '../form-item-images.service';
import {
  ANSWER_MAX_SELECTIONS,
  ANSWER_MAX_TEXT_LENGTH,
  FORM_MAX_QUESTIONS,
  GRID_MAX_ROWS,
  isAcceptedAnswerValue,
  PRODUCT_GRID_MAX_CELLS,
  GUEST_EMAIL_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  type FormAnswerValue,
} from '../answer-bounds';
import { GUEST_IDENTITY_FIELDS, type GuestIdentityField } from '../guest-identity';

/**
 * Validates that `answers` is a shallow Record of at most {@link FORM_MAX_QUESTIONS} keys whose
 * values are strings, string arrays, numbers, a survey grid's flat row map or a priced grid's
 * cell quantities - all within the bounds of
 * `libs/contracts/form-answers.json` (`isAcceptedAnswerValue`). A grid's rows and columns are judged
 * against the form by `submit`; this checks only the shape and the size.
 */
export function IsValidAnswers(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidAnswers',
      target: (object as { constructor: new (...args: unknown[]) => unknown }).constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length > FORM_MAX_QUESTIONS) return false;
          return entries.every(([, v]) => isAcceptedAnswerValue(v));
        },
        defaultMessage() {
          return `answers must contain at most ${FORM_MAX_QUESTIONS} keys; each value must be a string (max ${ANSWER_MAX_TEXT_LENGTH} chars), an array of strings (max ${ANSWER_MAX_SELECTIONS} items), a number, a survey grid of at most ${GRID_MAX_ROWS} rows, or a priced grid of at most ${PRODUCT_GRID_MAX_CELLS} cells`;
        },
      },
    });
  };
}

export class FormOptionDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  /** The option's price supplement in CENTS (the client sends `Math.round(euros * 100)`, the service
   * passes it straight to Stripe as a `unit_amount`), so a fractional value would be a fractional
   * cent - integer only. Never negative: `calculateModifiers` ignores a value <= 0, so a negative one
   * would show the payer a discount the charge never applies. */
  @IsInt()
  @Min(0)
  priceModifier: number;

  @IsString()
  @IsOptional()
  id?: string;
}

export class FormItemDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  @IsBoolean()
  required: boolean;

  /**
   * The question's kind, one of {@link SUPPORTED_QUESTION_TYPES} - the backend mirror of the
   * frontend's canonical `QUESTION_TYPES` (`frontend/src/lib/forms/questionTypes.ts`). The `single`
   * alias is read but never written, so it is not accepted here.
   */
  @IsIn(SUPPORTED_QUESTION_TYPES)
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormOptionDto)
  @IsOptional()
  options?: FormOptionDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  rows?: string[];

  /**
   * A REQUIRED grid demands an answer in every row when this is on; off (the default) one answered
   * row is enough (decided 2026-11-06, D5). Read only for `matrix_single` / `matrix_multiple`.
   */
  @IsBoolean()
  @IsOptional()
  requireEveryRow?: boolean;

  @IsOptional()
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };

  /**
   * Bounded by `form_files."itemId"` (varchar 64): a longer id saved here would make every upload
   * for that question a database error. Ids are UUIDs (36) or short legacy keys.
   */
  @IsString()
  @IsOptional()
  @MaxLength(FORM_ITEM_ID_MAX_LENGTH)
  id?: string;

  /** Optional help text displayed below the question label in the fill page. */
  @IsString()
  @IsOptional()
  description?: string;

  /**
   * Optional image shown under the question's label and help: the public URL the item-image upload
   * answered (`/api/media/public/<uuid>`) and nothing else - never an outside address a guest's
   * browser would be sent to. An empty string is no image. WHICH ids a form may cite is the
   * service's check (`FormItemImagesService.claimForSave`).
   */
  @IsString()
  @IsOptional()
  @Matches(new RegExp(`${QUESTION_IMAGE_URL_RE.source}|^$`), {
    message: 'imageUrl must be an image uploaded for this form',
  })
  imageUrl?: string;

  /** The image's text alternative, read by a screen reader; absent: the question's label is used. */
  @IsString()
  @IsOptional()
  @MaxLength(QUESTION_IMAGE_ALT_MAX_LENGTH)
  imageAlt?: string;

  /**
   * Legacy conditional display: the id of the question this one depends on. Still accepted and
   * still honoured, translated into a `showIf.answer` by `normaliseCondition` so there is one
   * evaluator rather than two that can disagree.
   */
  @IsString()
  @IsOptional()
  dependsOn?: string;

  /** Option id that must be selected in `dependsOn` for this question to appear. */
  @IsString()
  @IsOptional()
  dependsValue?: string;

  /**
   * Show this question only to submitters matching these criteria - a cotisation tier, a promo, a
   * formation, or an answer to another question. AND across the criteria present.
   *
   * The generalisation of the pair above, and the same predicate the pricing grid is built from.
   * Validated structurally in the service (`assertAudienceConditionValid`) rather than by nested
   * DTOs: it is a small discriminated document, and a `@ValidateNested` tree over four optional
   * shapes reads worse than the function that has to exist anyway for the grid.
   */
  @IsOptional()
  showIf?: unknown;

  /**
   * A priced grid's definition (`type: 'product_grid'`): rows, columns, max per cell, closed cells,
   * prices. Validated structurally in the service (`normaliseProductGridItems`, the shared rule in
   * `product-grid-contract.ts`) like `showIf`, and stored normalised; ignored on any other type.
   */
  @IsOptional()
  productGrid?: unknown;
}

export class CreateFormDto {
  /**
   * CREATE ONLY: the create's idempotency key, minted by the client so that a create whose answer
   * was lost is sent again as the SAME create (the stored form is answered). Never the form's id:
   * the server mints that. An edit sending it is refused (`FORM_CREATE_KEY_ON_EDIT`).
   */
  @IsUUID('4')
  @IsOptional()
  clientCreateId?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** The form's base price in CENTS (the client sends `Math.round(euros * 100)`, the service prices
   * `baseCents: form.basePrice`), so a fractional value would be a fractional cent - integer only. */
  @IsInt()
  @Min(0)
  basePrice: number;

  @IsString()
  @IsNotEmpty()
  currency: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  maxSubmissions?: number;

  @IsDateString()
  @IsOptional()
  opensAt?: string;

  /** ISO date string; when set, the form closes at this instant. */
  @IsDateString()
  @IsOptional()
  closedAt?: string;

  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  paymentMethods?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemDto)
  items: FormItemDto[];

  @IsString()
  @IsOptional()
  ownerId?: string;

  /**
   * The association the form belongs to. On an edit: absent leaves it; `''` or `null` names none.
   * Only a DRAFT may change it (`FormsService.associationAfterEdit`).
   */
  @IsString()
  @IsOptional()
  associationId?: string | null;

  /**
   * The pricing grid: `{ dimensions, cells }`. Absent or null leaves `basePrice` the only price.
   *
   * Validated by `assertMatrixValid`, which refuses an incomplete grid, overlapping groups inside
   * one criterion, and a reserved "everyone else" id - each of those being a submitter who would
   * have had no price, or a price decided by the order of two groups.
   */
  @IsOptional()
  priceMatrix?: unknown;

  /**
   * Who may submit at all, as the same criteria shape a grid's groups use. Absent or null means
   * anybody may.
   */
  @IsOptional()
  submitCondition?: unknown;

  /**
   * When true, a paid submission grants `associationId`'s cotisation to the submitter, through the
   * same path as a boutique purchase (tag derived at grant time, sibling tiers revoked).
   */
  @IsBoolean()
  @IsOptional()
  grantsCotisation?: boolean;

  /** Which tier `grantsCotisation` grants; null/absent = the base tier. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  cotisationVariantKey?: string | null;

  /** Store answers without their author. Free forms only, fixed at creation. */
  @IsBoolean()
  @IsOptional()
  anonymous?: boolean;

  /** Answerable without an account, from a shared link. Free, criteria-free, repeatable. */
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  /**
   * CREATE ONLY: `true` stores the form as a DRAFT, seen by its managers alone until
   * `POST /forms/:id/publish` (`form-status.ts`). Absent is a client that predates drafts: its form
   * is published at once, as it always was. Refused on an edit - publishing is its own route, and a
   * published form never goes back to draft.
   */
  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  /**
   * What a public form asks a guest about who they are (`guest-identity.ts`): any of `lastName`,
   * `firstName`, `email`, each required of the guest once asked. Absent keeps the stored value; an
   * empty list or null asks nothing (stored as null).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(GUEST_IDENTITY_FIELDS.length)
  @ArrayUnique()
  @IsIn(GUEST_IDENTITY_FIELDS, { each: true })
  guestFields?: GuestIdentityField[] | null;

  /** Allow the same user to submit multiple times (e.g. product orders). */
  @IsBoolean()
  @IsOptional()
  allowMultipleSubmissions?: boolean;

  /** Whether cash (physical) payment is accepted alongside the online payment. */
  @IsBoolean()
  @IsOptional()
  allowCashPayment?: boolean;

  /**
   * Whether online payment is accepted (`payment-offer.ts`). Absent keeps the stored value - true
   * for a new form, which is what every client before the choice meant.
   */
  @IsBoolean()
  @IsOptional()
  allowOnlinePayment?: boolean;

  /** Days before an unvalidated cash submission expires. */
  @IsInt()
  @IsOptional()
  @Min(1)
  cashPaymentExpiryDays?: number;

  /**
   * Days a FILE question's file is kept after the answer, 1 to 30 (decisions D23, D41). Absent keeps
   * the stored value (7 for a new form). The database holds the same range as a CHECK.
   */
  @IsInt()
  @IsOptional()
  @Min(FILE_RETENTION_MIN_DAYS)
  @Max(FILE_RETENTION_MAX_DAYS)
  fileRetentionDays?: number;
}

export class UpdateFormDto extends CreateFormDto {}

/**
 * An autosave of the editor (owner, 2026-11-08; `form-draft-revision.ts`): the revision it was built
 * on, and the whole payload as typed. The document is NOT validated here - a half-built form is what
 * an autosave carries - but as an edit's body when the revision is published.
 */
export class SaveFormDraftDto {
  @IsInt()
  @Min(0)
  baseRevision: number;

  @IsObject()
  document: Record<string, unknown>;

  /**
   * The client's id for THIS save, kept on the revision it writes: a client whose answer was lost
   * finds its own id in the 409 of its next save, and adopts the revision instead of a conflict.
   */
  @IsUUID('4')
  @IsOptional()
  saveId?: string;
}

/** Publishing or discarding the unpublished revision the editor holds, by its number. */
export class FormRevisionDto {
  @IsInt()
  @Min(0)
  revision: number;
}

/**
 * Publishing the revision: `overwrite` confirms publishing over a form written since the revision
 * started (refused `FORM_CHANGED_SINCE_REVISION` without it).
 */
export class PublishFormRevisionDto extends FormRevisionDto {
  @IsBoolean()
  @IsOptional()
  overwrite?: boolean;
}

/**
 * A guest's answer to a public form: the answers, how they pay when the form charges, and - only
 * when the form asks for them (`guest-identity.ts`, owner 2026-11-06) - a name and an e-mail. No
 * account, no stored network address, no return URL - the server chooses where Lydia sends a guest
 * back (`FormsService.submit`).
 */
export class GuestSubmitFormDto {
  @IsValidAnswers()
  answers: Record<string, FormAnswerValue>;

  /**
   * Where Lydia sends the payment request when the form does NOT ask for the guest's e-mail.
   * Forwarded to core-service, never persisted (PP2). When the form asks for it, `guestEmail` is
   * that address and this field is not read.
   */
  @IsEmail()
  @IsOptional()
  payerEmail?: string;

  /**
   * A guest's last name, first name and e-mail - only when the form asks for each
   * (`guest-identity.ts`, which refuses one it does not ask and requires one it does). When the
   * form asks for the e-mail it is also where Lydia sends the payment request (one address, typed
   * once), and it is stored with the answer.
   */
  @IsString()
  @IsOptional()
  @MaxLength(GUEST_NAME_MAX_LENGTH)
  guestLastName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(GUEST_NAME_MAX_LENGTH)
  guestFirstName?: string;

  @IsEmail()
  @IsOptional()
  @MaxLength(GUEST_EMAIL_MAX_LENGTH)
  guestEmail?: string;

  /** `online` (default) or `cash` (when the form allows it). */
  @IsString()
  @IsIn(['online', 'cash'])
  @IsOptional()
  paymentMethod?: string;

  /**
   * A HONEYPOT: a field the page hides from people, which a form-filling bot fills. Anything in it
   * and the answer is dropped - see `PublicFormsController.submit`.
   */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  website?: string;
}

/**
 * The guest return page's proof (`guest-receipt.ts`). In the BODY, never the path, so it stays out
 * of the access logs. Only its length is checked here: a wrong shape is answered like an unknown
 * receipt by the service, so a guess learns nothing from a 400.
 */
export class GuestReceiptDto {
  @IsString()
  @MaxLength(64)
  receipt: string;
}

export class SubmitFormDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

  /** Where Lydia sends the payment request. Forwarded to core-service, never persisted. */
  @IsEmail()
  @IsOptional()
  payerEmail?: string;

  /**
   * DECLARED SO A MEMBER'S ANSWER CARRYING THEM IS REFUSED, NOT STRIPPED. A member is never asked
   * for a guest's name or e-mail (Canari knows who they are); the global pipe's `whitelist` would
   * silently drop an undeclared field, and a dropped field is a save that did something else than
   * it said. `guestIdentityFor` answers 400 `FORM_GUEST_IDENTITY_NOT_ASKED` for any of them.
   */
  @IsOptional()
  guestLastName?: string;

  @IsOptional()
  guestFirstName?: string;

  @IsOptional()
  guestEmail?: string;

  @IsValidAnswers()
  answers: Record<string, FormAnswerValue>;

  @IsString()
  @IsOptional()
  successUrl?: string;

  @IsString()
  @IsOptional()
  cancelUrl?: string;

  /** `online` (default) or `cash` (when the form allows it). */
  @IsString()
  @IsIn(['online', 'cash'])
  @IsOptional()
  paymentMethod?: string;
}
