import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
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
import { PRODUCT_GRID_MAX_COLUMNS, PRODUCT_GRID_MAX_ROWS } from '../product-grid-contract';

/** Max keys per answers record - prevents oversized payloads. */
const ANSWERS_MAX_KEYS = 50;
/** Max character length per string answer. */
const ANSWERS_MAX_STRING_LEN = 2000;
/** Max number of selected options per multi-select answer. */
const ANSWERS_MAX_ARRAY_LEN = 50;
/**
 * Max keys of ONE object answer: a priced grid's cells (`rowId:colId` -> quantity) at the largest
 * grid a save accepts. A survey grid (`{ row: value }`) has far fewer rows.
 */
const ANSWERS_MAX_OBJECT_KEYS = PRODUCT_GRID_MAX_ROWS * PRODUCT_GRID_MAX_COLUMNS;
/** Max length of one key of an object answer: two 36-character ids and `:`, or a survey row label. */
const ANSWERS_MAX_OBJECT_KEY_LEN = 200;

/** One scalar answer value: a string, a list of strings, or a number. */
type AnswerScalar = string | string[] | number;
/** One answer: a scalar, or ONE level of object of scalars (a grid's answer). */
export type AnswerValue = AnswerScalar | Record<string, AnswerScalar>;

/** Whether a value is a scalar answer within bounds. */
function isValidScalar(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= ANSWERS_MAX_STRING_LEN;
  if (Array.isArray(v)) {
    return (
      v.length <= ANSWERS_MAX_ARRAY_LEN &&
      v.every((item) => typeof item === 'string' && item.length <= ANSWERS_MAX_STRING_LEN)
    );
  }
  return typeof v === 'number';
}

/**
 * Validates that `answers` is a Record whose values are strings, string arrays, numbers, or ONE
 * level of object of those (a grid's answer: a priced grid's `{ "rowId:colId": quantity }`), all
 * within accepted size bounds. What each question's value MEANS is judged by `submit`.
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
          if (entries.length > ANSWERS_MAX_KEYS) return false;
          for (const [, v] of entries) {
            if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
              const inner = Object.entries(v as Record<string, unknown>);
              if (inner.length > ANSWERS_MAX_OBJECT_KEYS) return false;
              if (
                inner.some(([k, x]) => k.length > ANSWERS_MAX_OBJECT_KEY_LEN || !isValidScalar(x))
              )
                return false;
            } else if (!isValidScalar(v)) {
              return false;
            }
          }
          return true;
        },
        defaultMessage() {
          return `answers must contain at most ${ANSWERS_MAX_KEYS} keys; each value must be a string (max ${ANSWERS_MAX_STRING_LEN} chars), an array of strings (max ${ANSWERS_MAX_ARRAY_LEN} items), a number, or an object of those (max ${ANSWERS_MAX_OBJECT_KEYS} keys)`;
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

  /** Optional image URL displayed above the input field in the fill page. */
  @IsString()
  @IsOptional()
  imageUrl?: string;

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

  @IsString()
  @IsOptional()
  associationId?: string;

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

  /** Allow the same user to submit multiple times (e.g. product orders). */
  @IsBoolean()
  @IsOptional()
  allowMultipleSubmissions?: boolean;

  /** Whether cash (physical) payment is accepted alongside the online payment. */
  @IsBoolean()
  @IsOptional()
  allowCashPayment?: boolean;

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
 * A guest's answer to a public form: the answers, how they pay when the form charges, and nothing
 * that could name anyone. No account, no stored address, no return URL - the server chooses where
 * Lydia sends a guest back (`FormsService.submit`).
 */
export class GuestSubmitFormDto {
  @IsValidAnswers()
  answers: Record<string, AnswerValue>;

  /** Where Lydia sends the payment request. Forwarded to core-service, never persisted (PP2). */
  @IsEmail()
  @IsOptional()
  payerEmail?: string;

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

  @IsValidAnswers()
  answers: Record<string, AnswerValue>;

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
