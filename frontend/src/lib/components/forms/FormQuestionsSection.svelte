<script lang="ts">
  import { tick } from 'svelte';
  import FormBuilder from './FormBuilder.svelte';
  import FormSection from './FormSection.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { AUTHORABLE_QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { duplicateQuestion } from '$lib/forms/questionDuplicate';
  import { ListChecks, Plus } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { draggableCard } from '$lib/actions/draggableCard';

  /**
   * The question builder: the list, its drag-and-drop reordering, and the type picker.
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
  }: Props = $props();

  let dragIndex = $state(-1);
  let dropIndex = $state(-1);
  let showTypePicker = $state(false);
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

  function addItem(type: string = 'short_text') {
    const id = crypto.randomUUID();
    expandedId = id;
    selectTitleId = null;
    items = [
      ...items,
      {
        id,
        label: '',
        required: false,
        type,
        options: [{ label: '', priceModifier: undefined }],
        rows: [],
      },
    ];
    showTypePicker = false;
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
    if (items[index]?.id === expandedId) expandedId = null;
    items = items.filter((_, i) => i !== index);
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
        />
      </div>
    {/each}
  </div>

  <div class="relative">
    <button
      bind:this={addButtonEl}
      type="button"
      onclick={() => (showTypePicker = !showTypePicker)}
      class="border-cn-border text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-3 text-sm font-bold transition-all"
    >
      <Plus size={18} />
      {m.form_add_question_button()}
    </button>

    {#if showTypePicker}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="fixed inset-0 z-(--z-popover-scrim)"
        onclick={() => (showTypePicker = false)}
      ></div>
      <div
        class="border-cn-border absolute right-0 bottom-full left-0 z-(--z-popover) mb-2 rounded-2xl border-2 bg-(--cn-surface) p-3 shadow-xl"
      >
        <p class="text-text-muted text-2xs mb-2.5 ml-1 font-bold tracking-wider uppercase">
          {m.form_question_type_picker_label()}
        </p>
        <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {#each AUTHORABLE_QUESTION_TYPES as qtype (qtype.value)}
            {@const Icon = qtype.Icon}
            <button
              type="button"
              onclick={() => addItem(qtype.value)}
              class="border-cn-border hover:border-cn-yellow hover:bg-cn-yellow/5 group flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition-all"
            >
              <Icon size={18} class="text-text-muted group-hover:text-cn-dark transition-colors" />
              <span
                class="text-text-muted group-hover:text-text-main text-2xs leading-tight font-semibold"
                >{qtype.label()}</span
              >
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</FormSection>
