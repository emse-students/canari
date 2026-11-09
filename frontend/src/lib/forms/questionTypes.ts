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
 * (WP-G1) was refused at save with `PRODUCT_GRID_DEFINITION_MISSING` until its editor (WP-G3,
 * `ProductGridEditor.svelte`) wrote its definition. A type joins this list in the change that ships
 * its editor (`questionTypes.test.ts`). A builder with no payment (a booking space) leaves the priced
 * grid out on its own (`FormQuestionsSection`'s `offerPricedGrid`).
 */
export const AUTHORABLE_QUESTION_TYPE_VALUES: readonly string[] = [
  ...TYPES_WITH_EVERY_SURFACE,
  'product_grid',
];

/** {@link QUESTION_TYPES} restricted to {@link AUTHORABLE_QUESTION_TYPE_VALUES}, in canonical order. */
export const AUTHORABLE_QUESTION_TYPES: QuestionType[] = QUESTION_TYPES.filter((t) =>
  AUTHORABLE_QUESTION_TYPE_VALUES.includes(t.value)
);

/**
 * The types the fill page DRAWS an input for (`fillAnswers.ts` `isKnownQuestionType`); any other
 * is drawn as "update the app" and blocks a send when required. Not `QUESTION_TYPES` either: a type
 * joins this list with its fill page, which may ship apart from its editor - `product_grid` did
 * (WP-G2, `ProductGridQuestion.svelte`) before the grid editor (WP-G3).
 */
export const FILLABLE_QUESTION_TYPE_VALUES: readonly string[] = [
  ...TYPES_WITH_EVERY_SURFACE,
  'product_grid',
];

/** A survey grid answered with ONE column per row (radio buttons). */
export const MATRIX_SINGLE_TYPE = 'matrix_single';
/** A survey grid answered with any number of columns per row (checkboxes). */
export const MATRIX_MULTIPLE_TYPE = 'matrix_multiple';

/** Whether a stored type is one of the two survey grids, edited as one "Grille de choix". */
export function isMatrixType(type: string | undefined): boolean {
  return type === MATRIX_SINGLE_TYPE || type === MATRIX_MULTIPLE_TYPE;
}

/**
 * The stored type behind the "Plusieurs reponses par ligne" switch. The two stored types are
 * unchanged on the wire and on the server (owner, 2026-11-07); only the editor shows them as one.
 */
export function matrixTypeFor(multiplePerRow: boolean): string {
  return multiplePerRow ? MATRIX_MULTIPLE_TYPE : MATRIX_SINGLE_TYPE;
}

/** The editor's one entry for the two survey grids. */
export const CHOICE_GRID_KIND = 'matrix';

/**
 * One entry of the editor's type menus. A KIND is what the editor offers; `type` is what a NEW
 * question of that kind is stored as. They differ for one kind only: the "Grille de choix", which
 * stores `matrix_single` or `matrix_multiple` by its switch.
 */
export interface EditorQuestionKind {
  kind: string;
  type: string;
  label: () => string;
  /** One short line saying what the respondent does with it, under the label in the add wizard. */
  description: () => string;
  Icon: Component<any>;
}

/** A titled group of kinds: the add wizard's step 1 and the card's type menu draw these. */
export interface EditorQuestionFamily {
  id: 'text' | 'choice' | 'grids' | 'other';
  title: () => string;
  kinds: EditorQuestionKind[];
}

const KIND_DESCRIPTIONS: Record<string, () => string> = {
  short_text: () => m.qtype_desc_short_text(),
  long_text: () => m.qtype_desc_long_text(),
  single_choice: () => m.qtype_desc_single_choice(),
  multiple_choice: () => m.qtype_desc_multiple_choice(),
  dropdown: () => m.qtype_desc_dropdown(),
  linear_scale: () => m.qtype_desc_linear_scale(),
  [CHOICE_GRID_KIND]: () => m.qtype_desc_matrix(),
  file: () => m.qtype_desc_file(),
  product_grid: () => m.qtype_desc_product_grid(),
};

/** The families and their order (owner, 2026-11-07). Every authorable kind sits in exactly one. */
const FAMILY_LAYOUT: { id: EditorQuestionFamily['id']; title: () => string; kinds: string[] }[] = [
  { id: 'text', title: () => m.qfamily_text(), kinds: ['short_text', 'long_text'] },
  {
    id: 'choice',
    title: () => m.qfamily_choice(),
    kinds: ['single_choice', 'multiple_choice', 'dropdown', 'linear_scale'],
  },
  { id: 'grids', title: () => m.qfamily_grids(), kinds: [CHOICE_GRID_KIND, 'product_grid'] },
  { id: 'other', title: () => m.qfamily_other(), kinds: ['file'] },
];

/** The kind a stored type is edited as: both survey grids are the "Grille de choix". */
export function editorKindOf(type: string | undefined): string {
  return isMatrixType(type) ? CHOICE_GRID_KIND : (type ?? '');
}

/** The editor entry of one kind, built from the canonical type (or the grid's own entry). */
function kindEntry(kind: string, offered: readonly QuestionType[]): EditorQuestionKind | null {
  if (kind === CHOICE_GRID_KIND) {
    if (!offered.some((t) => isMatrixType(t.value))) return null;
    return {
      kind,
      type: MATRIX_SINGLE_TYPE,
      label: () => m.qtype_matrix(),
      description: KIND_DESCRIPTIONS[kind],
      Icon: LayoutGrid,
    };
  }
  const type = offered.find((t) => t.value === kind);
  if (!type) return null;
  return {
    kind,
    type: type.value,
    label: type.label,
    description: KIND_DESCRIPTIONS[kind] ?? (() => ''),
    Icon: type.Icon,
  };
}

/**
 * The editor's type menus: the families, in order, holding only the kinds `offered` allows (the
 * authorable types, less the priced grid on a builder that never takes payment). An empty family
 * is left out.
 */
export function editorQuestionFamilies(
  offered: readonly QuestionType[] = AUTHORABLE_QUESTION_TYPES
): EditorQuestionFamily[] {
  return FAMILY_LAYOUT.map((family) => ({
    id: family.id,
    title: family.title,
    kinds: family.kinds
      .map((kind) => kindEntry(kind, offered))
      .filter((k): k is EditorQuestionKind => k !== null),
  })).filter((family) => family.kinds.length > 0);
}

/** The editor entry a stored question is shown as (its icon and label), or null for an unknown type. */
export function editorKindEntry(type: string | undefined): EditorQuestionKind | null {
  return kindEntry(editorKindOf(type), QUESTION_TYPES);
}
