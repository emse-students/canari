<script lang="ts">
  import { tick } from 'svelte';
  import FormBuilder from './FormBuilder.svelte';
  import FormSection from './FormSection.svelte';
  import AddQuestionWizard from './AddQuestionWizard.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { AUTHORABLE_QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { duplicateQuestion } from '$lib/forms/questionDuplicate';
  import { PRODUCT_GRID_TYPE } from '$lib/forms/productGridContract';
  import type { ProductGridTierDimension } from '$lib/forms/productGridEditor';
  import { insertQuestion, type DraftQuestion } from '$lib/forms/questionDraft';
  import { Log } from '$lib/utils/Log';
  import { ListChecks, Plus } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { draggableCard } from '$lib/actions/draggableCard';

  /**
   * The question builder: the list, its drag-and-drop reordering, and the add wizard
   * (`AddQuestionWizard`), opened from the button under the list (a question at the end) or from a
   * card's "..." menu (a question right after that card).
   *
   * The create and edit screens each held a verbatim copy of all ninety lines of this, differing
   * only in whether they passed an image uploader - so every fix to the picker or the drag
   * handling had to be made twice, and the reorder helpers existed twice per screen.
   */
  interface Props {
    /** The questions, mutated in place. */
    items: any[];
    /** Whether questions may carry a price supplement. */
    requiresPayment: boolean;
    /**
     * Ids of the questions the pricing grid discriminates on. Their per-option supplements are
     * hidden, because the grid cell already carries the choice - adding a supplement on top would
     * charge it twice.
     */
    gridQuestionIds?: string[];
    /** Cotisation tiers of the beneficiary association, for a question's audience condition. */
    tiers?: MembershipTier[];
    /** Formation values in use, for a question's audience condition. */
    formations?: FormationOption[];
    /**
     * Uploads an image for a question and returns its URL. Absent on the create screen, where
     * there is no form id to attach an upload to yet.
     */
    imageUploadFn?: (file: File) => Promise<string>;
    /** What a FILE question says it does, in the editor; a booking space passes its own. */
    fileHint?: string;
    /**
     * A question to open: the page sets a NEW object each time a save refuses because of that
     * question, so asking twice for the same one still opens it again.
     */
    reveal?: { id: string } | null;
    /**
     * Whether the type menus offer the priced grid. A builder whose answers never pay (a booking
     * space) passes false: every grid there would be refused `PRODUCT_GRID_REQUIRES_PAYMENT`.
     */
    offerPricedGrid?: boolean;
    /** A priced grid was added (or a question became one): the page switches several answers on. */
    onPricedGridAdded?: () => void;
    /**
     * A priced grid was removed or turned into another type, called once `items` no longer holds
     * it: the page may switch back off what adding it switched on.
     */
    onPricedGridGone?: () => void;
    /** The registration price grid's profile criterion, which a priced grid may copy in one click. */
    formTiers?: ProductGridTierDimension | null;
    /** Per priced grid, the cells already ordered in an answer (edit page only). */
    orderedCells?: Record<string, string[]>;
    /** A public form: a priced grid's guest pays "everyone else". */
    isPublic?: boolean;
    /** The priced grid a refused save is about, and its sentence - drawn under that grid. */
    gridFault?: { itemId: string; message: string } | null;
  }

  let {
    items = $bindable(),
    requiresPayment,
    gridQuestionIds = [],
    tiers = [],
    formations = [],
    imageUploadFn,
    fileHint,
    reveal = null,
    offerPricedGrid = true,
    onPricedGridAdded,
    onPricedGridGone,
    formTiers = null,
    orderedCells = {},
    isPublic = false,
    gridFault = null,
  }: Props = $props();

  const types = $derived(
    offerPricedGrid
      ? AUTHORABLE_QUESTION_TYPES
      : AUTHORABLE_QUESTION_TYPES.filter((t) => t.value !== PRODUCT_GRID_TYPE)
  );

  let dragIndex = $state(-1);
  let dropIndex = $state(-1);
  /** The add wizard, and where its question goes: after that index, or at the end (null). */
  let wizard = $state<{ afterIndex: number | null } | null>(null);
  let listEl = $state<HTMLElement | null>(null);
  let addButtonEl = $state<HTMLButtonElement | null>(null);
  /** The one question being edited; the others are a single line each. */
  let expandedId = $state<string | null>(null);
  /** The copy of a question opens with its title selected. */
  let selectTitleId = $state<string | null>(null);

  $effect(() => {
    if (reveal) {
      expandedId = reveal.id;
      selectTitleId = null;
    }
  });

  const countLabel = $derived(
    items.length === 1
      ? m.form_questions_count_one()
      : m.form_questions_count({ count: items.length })
  );

  function openWizard(afterIndex: number | null) {
    Log.d('FormQuestionsSection', `add wizard opened, after ${afterIndex ?? 'the end'}`);
    wizard = { afterIndex };
  }

  function cancelWizard() {
    Log.d('FormQuestionsSection', 'add wizard cancelled, nothing inserted');
    // The dialog's focus trap gives the focus back to what opened it: the add button, or the
    // card's "..." button (which takes it back from its menu before asking).
    wizard = null;
  }

  /** "Ajouter": the filled question goes where the wizard was opened from, and opens there. */
  function addQuestion(question: DraftQuestion) {
    const afterIndex = wizard?.afterIndex ?? null;
    wizard = null;
    items = insertQuestion(items, question, afterIndex);
    selectTitleId = null;
    expandedId = question.id;
    if (question.type === PRODUCT_GRID_TYPE) onPricedGridAdded?.();
  }

  function duplicateItem(index: number) {
    const result = duplicateQuestion(items, index);
    if (!result) return;
    items = result.items;
    selectTitleId = result.copyId;
    expandedId = result.copyId;
  }

  /**
   * Removes a question and puts focus where the person is still working: the row that took its
   * place, else the one before it, else the "add a question" button - never the page.
   */
  async function removeItem(index: number) {
    const removed = items[index];
    if (removed?.id === expandedId) expandedId = null;
    items = items.filter((_, i) => i !== index);
    if (removed?.type === PRODUCT_GRID_TYPE) onPricedGridGone?.();
    await tick();
    const rows = listEl?.querySelectorAll<HTMLElement>('[data-row-button]');
    (rows?.[index] ?? rows?.[index - 1] ?? addButtonEl)?.focus();
  }

  function moveItem(index: number, direction: 'up' | 'down') {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= items.length) return;
    const copy = [...items];
    [copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
    items = copy;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    dropIndex = index;
  }

  function handleDrop(index: number) {
    if (dragIndex === -1 || dragIndex === index) {
      resetDrag();
      return;
    }
    const copy = [...items];
    const [moved] = copy.splice(dragIndex, 1);
    copy.splice(index, 0, moved);
    items = copy;
    resetDrag();
  }

  function resetDrag() {
    dragIndex = -1;
    dropIndex = -1;
  }
</script>

<FormSection title={m.form_section_questions()} icon={ListChecks} badge={countLabel} dense>
  <div class="space-y-2" bind:this={listEl}>
    {#each items as _item, i (_item.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        use:draggableCard
        ondragstart={() => (dragIndex = i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondrop={() => handleDrop(i)}
        ondragend={resetDrag}
        class="transition-all duration-150 {dragIndex === i
          ? 'scale-[0.98] opacity-40'
          : ''} {dropIndex === i && dragIndex !== i
          ? 'ring-cn-yellow/60 rounded-4xl ring-2 ring-offset-1'
          : ''}"
      >
        <FormBuilder
          bind:item={items[i]}
          onRemove={() => removeItem(i)}
          showPriceModifier={requiresPayment}
          pricedByGrid={gridQuestionIds.includes(items[i]?.id)}
          questionIndex={i + 1}
          onMoveUp={() => moveItem(i, 'up')}
          onMoveDown={() => moveItem(i, 'down')}
          canMoveUp={i > 0}
          canMoveDown={i < items.length - 1}
          allItems={items}
          {tiers}
          {formations}
          {imageUploadFn}
          {fileHint}
          expanded={expandedId === _item.id}
          selectTitleOnOpen={selectTitleId === _item.id}
          onExpand={() => {
            selectTitleId = null;
            expandedId = _item.id;
          }}
          onCollapse={() => {
            if (expandedId === _item.id) expandedId = null;
          }}
          onDuplicate={() => duplicateItem(i)}
          onInsertAfter={() => openWizard(i)}
          authorableTypes={types}
          onBecamePricedGrid={onPricedGridAdded}
          onLeftPricedGrid={onPricedGridGone}
          {formTiers}
          orderedCells={orderedCells[_item.id] ?? []}
          {isPublic}
          gridProblem={gridFault?.itemId === _item.id ? (gridFault?.message ?? null) : null}
        />
      </div>
    {/each}
  </div>

  <button
    bind:this={addButtonEl}
    type="button"
    onclick={() => openWizard(null)}
    aria-haspopup="dialog"
    class="border-cn-border text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-3 text-sm font-bold transition-all"
  >
    <Plus size={18} />
    {m.form_add_question_button()}
  </button>

  <AddQuestionWizard
    open={wizard !== null}
    offered={types}
    {requiresPayment}
    {tiers}
    {formations}
    {formTiers}
    {isPublic}
    onCancel={cancelWizard}
    onAdd={addQuestion}
  />
</FormSection>
