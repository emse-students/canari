import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Max keys per answers record - prevents oversized payloads. */
const ANSWERS_MAX_KEYS = 50;
/** Max character length per string answer. */
const ANSWERS_MAX_STRING_LEN = 2000;
/** Max number of selected options per multi-select answer. */
const ANSWERS_MAX_ARRAY_LEN = 50;

/**
 * Validates that `answers` is a shallow Record whose values are strings, string arrays, or numbers,
 * all within accepted size bounds.
 */
function IsValidAnswers(options?: ValidationOptions) {
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
            if (typeof v === 'string') {
              if (v.length > ANSWERS_MAX_STRING_LEN) return false;
            } else if (Array.isArray(v)) {
              if (v.length > ANSWERS_MAX_ARRAY_LEN) return false;
              if (
                v.some((item) => typeof item !== 'string' || item.length > ANSWERS_MAX_STRING_LEN)
              )
                return false;
            } else if (typeof v !== 'number') {
              return false;
            }
          }
          return true;
        },
        defaultMessage() {
          return `answers must contain at most ${ANSWERS_MAX_KEYS} keys; each value must be a string (max ${ANSWERS_MAX_STRING_LEN} chars), an array of strings (max ${ANSWERS_MAX_ARRAY_LEN} items), or a number`;
        },
      },
    });
  };
}

export class FormOptionDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  @IsNumber()
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

  @IsString()
  @IsNotEmpty()
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

  @IsString()
  @IsOptional()
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
}

export class CreateFormDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsString()
  @IsNotEmpty()
  currency: string;

  @IsString()
  @IsNotEmpty()
  submitLabel: string;

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

  /** Allow the same user to submit multiple times (e.g. product orders). */
  @IsBoolean()
  @IsOptional()
  allowMultipleSubmissions?: boolean;

  /** Whether cash (physical) payment is accepted alongside Stripe. */
  @IsBoolean()
  @IsOptional()
  allowCashPayment?: boolean;

  /** Days before an unvalidated cash submission expires. */
  @IsInt()
  @IsOptional()
  @Min(1)
  cashPaymentExpiryDays?: number;
}

export class UpdateFormDto extends CreateFormDto {}

export class SubmitFormDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsValidAnswers()
  answers: Record<string, string | string[] | number>;

  @IsString()
  @IsOptional()
  successUrl?: string;

  @IsString()
  @IsOptional()
  cancelUrl?: string;

  /** `stripe` (default) or `cash` (when the form allows it). */
  @IsString()
  @IsIn(['stripe', 'cash'])
  @IsOptional()
  paymentMethod?: string;
}
