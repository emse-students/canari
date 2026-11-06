import {
  Type,
  TextAlignStart,
  CircleDot,
  SquareCheckBig,
  ChevronDown,
  SlidersHorizontal,
  LayoutGrid,
  Table2,
  Paperclip,
  ShoppingBag,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { m } from '$lib/paraglide/messages';

export interface QuestionType {
  value: string;
  /** Returns the locale-aware label; call at render time, not module init. */
  label: () => string;
  Icon: Component<any>;
}

/**
 * Canonical list of every question type a form may hold - what a form READS (a stored question's
 * icon and label) and what social-service's `SUPPORTED_QUESTION_TYPES` must equal (the drift test in
 * `form.dto.spec.ts`). The builders OFFER {@link AUTHORABLE_QUESTION_TYPES} instead.
 */
export const QUESTION_TYPES: QuestionType[] = [
  { value: 'short_text', label: () => m.qtype_short_text(), Icon: Type },
  { value: 'long_text', label: () => m.qtype_long_text(), Icon: TextAlignStart },
  { value: 'single_choice', label: () => m.qtype_single_choice(), Icon: CircleDot },
  { value: 'multiple_choice', label: () => m.qtype_multiple_choice(), Icon: SquareCheckBig },
  { value: 'dropdown', label: () => m.qtype_dropdown(), Icon: ChevronDown },
  { value: 'linear_scale', label: () => m.qtype_linear_scale(), Icon: SlidersHorizontal },
  { value: 'matrix_single', label: () => m.qtype_matrix_single(), Icon: LayoutGrid },
  { value: 'matrix_multiple', label: () => m.qtype_matrix_multiple(), Icon: Table2 },
  // A CV, a certificate: read by the form's managers on the server, purged days after the answer.
  { value: 'file', label: () => m.qtype_file(), Icon: Paperclip },
  // An order: rows x columns of quantities, priced by the server (WP-G1; editor WP-G3, fill WP-G2).
  { value: 'product_grid', label: () => m.qtype_product_grid(), Icon: ShoppingBag },
];

/** The types every surface of this build handles: the editor writes them, the fill page draws them. */
const TYPES_WITH_EVERY_SURFACE: readonly string[] = [
  'short_text',
  'long_text',
  'single_choice',
  'multiple_choice',
  'dropdown',
  'linear_scale',
  'matrix_single',
  'matrix_multiple',
  'file',
];

/**
 * The types the builders' pickers OFFER: every type whose editor exists.
 *
 * Not `QUESTION_TYPES`: a type the server accepts can ship before its editor does - `product_grid`
 * (WP-G1) is refused at save with `PRODUCT_GRID_DEFINITION_MISSING` until the grid editor (WP-G3)
 * writes its definition, so offering it would hand people a question no save accepts. A type joins
 * this list in the change that ships its editor (`questionTypes.test.ts`).
 */
export const AUTHORABLE_QUESTION_TYPE_VALUES: readonly string[] = [...TYPES_WITH_EVERY_SURFACE];

/** {@link QUESTION_TYPES} restricted to {@link AUTHORABLE_QUESTION_TYPE_VALUES}, in canonical order. */
export const AUTHORABLE_QUESTION_TYPES: QuestionType[] = QUESTION_TYPES.filter((t) =>
  AUTHORABLE_QUESTION_TYPE_VALUES.includes(t.value)
);

/**
 * The types the fill page DRAWS an input for (`fillAnswers.ts` `isKnownQuestionType`); any other
 * is drawn as "update the app" and blocks a send when required. Not `QUESTION_TYPES` either:
 * `product_grid` joins this list with its fill page (WP-G2), which may ship apart from its editor.
 */
export const FILLABLE_QUESTION_TYPE_VALUES: readonly string[] = [...TYPES_WITH_EVERY_SURFACE];
