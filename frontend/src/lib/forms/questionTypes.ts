import {
  Type,
  AlignLeft,
  CircleDot,
  CheckSquare,
  ChevronDown,
  SlidersHorizontal,
  LayoutGrid,
  Table2,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { m } from '$lib/paraglide/messages';

export interface QuestionType {
  value: string;
  /** Returns the locale-aware label; call at render time, not module init. */
  label: () => string;
  Icon: Component<any>;
}

/** Canonical list of question types used in form builders and pickers. */
export const QUESTION_TYPES: QuestionType[] = [
  { value: 'short_text', label: () => m.qtype_short_text(), Icon: Type },
  { value: 'long_text', label: () => m.qtype_long_text(), Icon: AlignLeft },
  { value: 'single_choice', label: () => m.qtype_single_choice(), Icon: CircleDot },
  { value: 'multiple_choice', label: () => m.qtype_multiple_choice(), Icon: CheckSquare },
  { value: 'dropdown', label: () => m.qtype_dropdown(), Icon: ChevronDown },
  { value: 'linear_scale', label: () => m.qtype_linear_scale(), Icon: SlidersHorizontal },
  { value: 'matrix_single', label: () => m.qtype_matrix_single(), Icon: LayoutGrid },
  { value: 'matrix_multiple', label: () => m.qtype_matrix_multiple(), Icon: Table2 },
];
