import { CopyPlus, ListPlus, Trash2 } from '@lucide/svelte';
import type { MenuListSection } from '$lib/components/ui/menuList';
import { m } from '$lib/paraglide/messages';
import { editorKindOf, type EditorQuestionFamily } from './questionTypes';

/**
 * THE FORM EDITOR'S MENUS, AS DATA: which sections, in which order, with which entries. The
 * components draw them through `MenuList`; the grouping lives here so a test can read it
 * (owner, 2026-11-07: sections with titles, the icon left, the text left-aligned).
 */

/**
 * The type families as menu sections. The add wizard shows each kind's one-line description; the
 * card's type menu, which only switches a type, shows labels alone and ticks the current kind.
 */
export function questionKindSections(
  families: readonly EditorQuestionFamily[],
  options: { currentType?: string; withDescriptions?: boolean } = {}
): MenuListSection[] {
  const current = options.currentType ? editorKindOf(options.currentType) : null;
  return families.map((family) => ({
    title: family.title(),
    items: family.kinds.map((kind) => ({
      key: kind.kind,
      label: kind.label(),
      description: options.withDescriptions ? kind.description() : undefined,
      Icon: kind.Icon,
      selected: current === kind.kind,
    })),
  }));
}

/** The keys of a question card's "..." menu. */
export type QuestionCardAction = 'insert_after' | 'duplicate' | 'remove';

/**
 * A question card's "..." menu: what ADDS a question (a new one after this card, or a copy), then,
 * apart, what removes it. Its settings stay in the card itself (required in the toolbar, the
 * conditions under "Plus d'options").
 */
export function questionCardMenuSections(): MenuListSection[] {
  return [
    {
      title: m.form_card_menu_section_add(),
      items: [
        { key: 'insert_after', label: m.form_card_menu_insert_after(), Icon: ListPlus },
        { key: 'duplicate', label: m.form_card_menu_duplicate(), Icon: CopyPlus },
      ],
    },
    {
      title: m.form_card_menu_section_remove(),
      items: [{ key: 'remove', label: m.form_builder_delete_aria(), Icon: Trash2, danger: true }],
    },
  ];
}
