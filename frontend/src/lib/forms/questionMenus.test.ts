import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { questionCardMenuSections, questionKindSections } from './questionMenus';
import {
  AUTHORABLE_QUESTION_TYPES,
  CHOICE_GRID_KIND,
  editorKindEntry,
  editorKindOf,
  editorQuestionFamilies,
  isMatrixType,
  matrixTypeFor,
} from './questionTypes';

describe('the type families (owner, 2026-11-07)', () => {
  it('groups the types in four titled families, in order', () => {
    const families = editorQuestionFamilies();
    expect(families.map((f) => f.id)).toEqual(['text', 'choice', 'grids', 'other']);
    expect(families.map((f) => f.kinds.map((k) => k.kind))).toEqual([
      ['short_text', 'long_text'],
      ['single_choice', 'multiple_choice', 'dropdown', 'linear_scale'],
      [CHOICE_GRID_KIND, 'product_grid'],
      ['file'],
    ]);
    expect(families.map((f) => f.title())).toEqual([
      m.qfamily_text(),
      m.qfamily_choice(),
      m.qfamily_grids(),
      m.qfamily_other(),
    ]);
  });

  it('places every authorable type in exactly one family, the two grids as one kind', () => {
    const kinds = editorQuestionFamilies().flatMap((f) => f.kinds);
    const covered = new Set(kinds.map((k) => k.kind));
    for (const type of AUTHORABLE_QUESTION_TYPES) {
      expect(covered.has(editorKindOf(type.value))).toBe(true);
    }
    expect(kinds.map((k) => k.kind)).toHaveLength(covered.size);
    expect(kinds.filter((k) => isMatrixType(k.type))).toHaveLength(1);
  });

  it('gives each kind a one-line description', () => {
    for (const kind of editorQuestionFamilies().flatMap((f) => f.kinds)) {
      expect(kind.description().length).toBeGreaterThan(0);
    }
  });

  it('leaves the priced grid out where it is not offered, and drops an empty family', () => {
    const noGrid = AUTHORABLE_QUESTION_TYPES.filter((t) => t.value !== 'product_grid');
    const kinds = editorQuestionFamilies(noGrid).flatMap((f) => f.kinds.map((k) => k.kind));
    expect(kinds).not.toContain('product_grid');
    const onlyText = AUTHORABLE_QUESTION_TYPES.filter((t) => t.value === 'short_text');
    expect(editorQuestionFamilies(onlyText).map((f) => f.id)).toEqual(['text']);
  });
});

describe('the "Grille de choix"', () => {
  it('maps its switch to the two stored types, unchanged', () => {
    expect(matrixTypeFor(false)).toBe('matrix_single');
    expect(matrixTypeFor(true)).toBe('matrix_multiple');
  });

  it('shows both stored types as the one kind, with its own label', () => {
    expect(editorKindOf('matrix_single')).toBe(CHOICE_GRID_KIND);
    expect(editorKindOf('matrix_multiple')).toBe(CHOICE_GRID_KIND);
    expect(editorKindEntry('matrix_multiple')?.label()).toBe(m.qtype_matrix());
    expect(editorKindEntry('short_text')?.label()).toBe(m.qtype_short_text());
    expect(editorKindEntry('nope')).toBeNull();
  });

  it('is offered once and adds a single-answer grid', () => {
    const grid = editorQuestionFamilies()
      .flatMap((f) => f.kinds)
      .find((k) => k.kind === CHOICE_GRID_KIND)!;
    expect(grid.type).toBe('matrix_single');
  });
});

describe('the menus as sections', () => {
  it('the type menu: one titled section per family, the current kind ticked', () => {
    const sections = questionKindSections(editorQuestionFamilies(), {
      currentType: 'matrix_multiple',
    });
    expect(sections.map((s) => s.title)).toEqual([
      m.qfamily_text(),
      m.qfamily_choice(),
      m.qfamily_grids(),
      m.qfamily_other(),
    ]);
    const selected = sections.flatMap((s) => s.items).filter((i) => i.selected);
    expect(selected.map((i) => i.key)).toEqual([CHOICE_GRID_KIND]);
    // The card's menu switches a type: labels alone, no description.
    expect(sections.flatMap((s) => s.items).every((i) => i.description === undefined)).toBe(true);
  });

  it('the wizard: the same sections, each type with its line', () => {
    const sections = questionKindSections(editorQuestionFamilies(), { withDescriptions: true });
    expect(sections.flatMap((s) => s.items).every((i) => !!i.description)).toBe(true);
  });

  it('the card "..." menu: what adds a question, then apart what removes it', () => {
    const sections = questionCardMenuSections();
    expect(sections.map((s) => s.title)).toEqual([
      m.form_card_menu_section_add(),
      m.form_card_menu_section_remove(),
    ]);
    expect(sections.map((s) => s.items.map((i) => i.key))).toEqual([
      ['insert_after', 'duplicate'],
      ['remove'],
    ]);
    expect(sections[1].items[0].danger).toBe(true);
    expect(sections.flatMap((s) => s.items).every((i) => i.Icon)).toBe(true);
  });
});
