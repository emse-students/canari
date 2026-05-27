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

export interface QuestionType {
  value: string;
  label: string;
  Icon: Component<any>;
}

/** Canonical list of question types used in form builders and pickers. */
export const QUESTION_TYPES: QuestionType[] = [
  { value: 'short_text', label: 'Texte court', Icon: Type },
  { value: 'long_text', label: 'Paragraphe', Icon: AlignLeft },
  { value: 'single_choice', label: 'Choix unique', Icon: CircleDot },
  { value: 'multiple_choice', label: 'Cases à cocher', Icon: CheckSquare },
  { value: 'dropdown', label: 'Liste déroulante', Icon: ChevronDown },
  { value: 'linear_scale', label: 'Échelle', Icon: SlidersHorizontal },
  { value: 'matrix_single', label: 'Grille unique', Icon: LayoutGrid },
  { value: 'matrix_multiple', label: 'Grille multiple', Icon: Table2 },
];
