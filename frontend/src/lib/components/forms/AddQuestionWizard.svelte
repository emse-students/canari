<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowLeft, X } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import ChoiceOptionsEditor from './ChoiceOptionsEditor.svelte';
  import ScaleEditor from './ScaleEditor.svelte';
  import MatrixGridEditor from './MatrixGridEditor.svelte';
  import ProductGridEditor from './ProductGridEditor.svelte';
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { CONTROL_LABEL_CLASS, controlClass } from '$lib/components/ui/controlClasses';
  import {
    AUTHORABLE_QUESTION_TYPES,
    editorQuestionFamilies,
    isMatrixType,
    type EditorQuestionKind,
    type QuestionType,
  } from '$lib/forms/questionTypes';
  import { questionKindSections } from '$lib/forms/questionMenus';
  import { newQuestion, type DraftQuestion } from '$lib/forms/questionDraft';
  import { PRODUCT_GRID_TYPE } from '$lib/forms/productGridContract';
  import type { ProductGridTierDimension } from '$lib/forms/productGridEditor';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * ADDING A QUESTION IN TWO STEPS (owner, 2026-11-07: *"il faut absolument mettre un wizard et
   * rendre les choses simples et bien ordonnees, sinon c'est vraiment une usine a gaz"*).
   *
   * Step 1, "Quel type de question ?": the types grouped by family under small titles, each with
   * its icon on the left, its label left-aligned and one line saying what it is for. Step 2: a
   * short sheet with only what that type cannot do without - its title, then its options, its
   * scale, its rows and columns, or its prices. "Ajouter" hands the filled question to the list,
   * which inserts it where the wizard was opened from; "Annuler", Escape, the backdrop or the
   * system Back insert nothing. The back arrow returns to step 1 and keeps nothing of the draft.
   *
   * Everything rarer - image, description, conditions, a grid's cap per cell - stays in the
   * question card. Step 2 REUSES the card's own editors (`ChoiceOptionsEditor`, `ScaleEditor`,
   * `MatrixGridEditor`, `ProductGridEditor` in its `essentials` form): one implementation of each.
   *
   * A bottom sheet on a phone, a centred dialog wider up (`Modal`, which traps the focus).
   */
  interface Props {
    open: boolean;
    /** The types offered (a builder with no payment leaves the priced grid out). */
    offered?: readonly QuestionType[];
    /** Whether a choice's options may carry a price supplement. */
    requiresPayment?: boolean;
    tiers?: MembershipTier[];
    formations?: FormationOption[];
    formTiers?: ProductGridTierDimension | null;
    isPublic?: boolean;
    /** Closed without adding. */
    onCancel: () => void;
    /** "Ajouter": the filled question, for the list to insert. */
    onAdd: (question: DraftQuestion) => void;
  }

  let {
    open,
    offered = AUTHORABLE_QUESTION_TYPES,
    requiresPayment = false,
    tiers = [],
    formations = [],
    formTiers = null,
    isPublic = false,
    onCancel,
    onAdd,
  }: Props = $props();

  const TAG = 'AddQuestionWizard';

  const families = $derived(editorQuestionFamilies(offered));
  const sections = $derived(questionKindSections(families, { withDescriptions: true }));

  let kind = $state<EditorQuestionKind | null>(null);
  let draft = $state<DraftQuestion | null>(null);
  let bodyEl = $state<HTMLElement | null>(null);

  const isText = $derived(draft?.type === 'short_text' || draft?.type === 'long_text');
  const isChoice = $derived(
    draft?.type === 'single_choice' ||
      draft?.type === 'multiple_choice' ||
      draft?.type === 'dropdown'
  );

  // Every opening starts at step 1, with the first type focused.
  $effect(() => {
    if (!open) return;
    kind = null;
    draft = null;
    void focusFirst('[data-menu-item]');
  });

  async function focusFirst(selector: string) {
    await tick();
    bodyEl?.querySelector<HTMLElement>(selector)?.focus();
  }

  function choose(key: string) {
    const picked = families.flatMap((f) => f.kinds).find((k) => k.kind === key);
    if (!picked) return;
    Log.d(TAG, `step 2 for ${picked.kind}`);
    kind = picked;
    draft = newQuestion(picked.type);
    void focusFirst('[data-wizard-title]');
  }

  function back() {
    const from = kind?.kind;
    Log.d(TAG, `back to step 1 from ${from}`);
    kind = null;
    draft = null;
    void focusFirst(`[data-menu-item="${from}"]`);
  }

  function add() {
    if (!draft) return;
    Log.d(TAG, `adding a ${draft.type} question`);
    onAdd($state.snapshot(draft) as DraftQuestion);
  }

  const title = $derived(kind ? kind.label() : m.form_add_wizard_title());
</script>

<Modal
  {open}
  {title}
  showTitleBar={false}
  maxWidth={draft?.type === PRODUCT_GRID_TYPE || (draft && isMatrixType(draft.type))
    ? 'max-w-3xl'
    : 'max-w-lg'}
  footerEdge
  onClose={onCancel}
>
  <div bind:this={bodyEl} data-testid="add-question-wizard" data-step={kind ? 'details' : 'type'}>
    <div class="mb-3 flex items-center gap-2">
      {#if kind}
        <button
          type="button"
          onclick={back}
          aria-label={m.form_add_wizard_back()}
          title={m.form_add_wizard_back()}
          data-testid="wizard-back"
          class="ui-icon-button text-text-muted hover:text-text-main -ml-2 shrink-0 rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
          ><ArrowLeft size={18} /></button
        >
        {@const Icon = kind.Icon}
        <Icon size={18} aria-hidden="true" class="text-text-muted shrink-0" />
      {/if}
      <h2 class="text-text-main min-w-0 flex-1 text-base font-bold">{title}</h2>
      <button
        type="button"
        onclick={onCancel}
        aria-label={m.common_close_label()}
        class="ui-icon-button text-text-muted hover:text-text-main -mr-2 shrink-0 rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
        ><X size={18} /></button
      >
    </div>

    {#if !draft}
      <MenuList {sections} label={m.form_add_wizard_title()} onSelect={choose} />
    {:else}
      <div class="space-y-4">
        <div>
          <label for="wizard-title-{draft.id}" class={CONTROL_LABEL_CLASS}
            >{m.form_add_wizard_label()}</label
          >
          <input
            id="wizard-title-{draft.id}"
            data-wizard-title
            type="text"
            bind:value={draft.label}
            placeholder={m.form_add_wizard_label_placeholder()}
            class={controlClass(false)}
            onkeydown={(e) => {
              // Enter in the title adds a question that needs nothing else (a text, a file).
              if (e.key === 'Enter' && !e.isComposing && (isText || draft?.type === 'file')) {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>

        {#if isChoice}
          <ChoiceOptionsEditor item={draft} showPriceModifier={requiresPayment} />
        {:else if draft.type === 'linear_scale'}
          <ScaleEditor item={draft as any} />
        {:else if isMatrixType(draft.type)}
          <MatrixGridEditor item={draft} />
        {:else if draft.type === PRODUCT_GRID_TYPE && draft.productGrid}
          <ProductGridEditor
            grid={draft.productGrid as any}
            {tiers}
            {formations}
            {formTiers}
            {isPublic}
            title={draft.label}
            essentials
          />
        {:else}
          <Toggle label={m.form_add_wizard_required()} bind:checked={draft.required} />
        {/if}

        <p class="text-text-muted text-xs">{m.form_add_wizard_later()}</p>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      onclick={onCancel}
      class="text-text-main hover:bg-cn-bg min-h-11 rounded-lg px-4 text-sm font-bold"
      >{m.common_cancel_button()}</button
    >
    {#if draft}
      <button
        type="button"
        onclick={add}
        data-testid="wizard-add"
        class="bg-accent text-on-accent min-h-11 rounded-lg px-5 text-sm font-bold"
        >{m.form_add_wizard_add()}</button
      >
    {/if}
  {/snippet}
</Modal>
