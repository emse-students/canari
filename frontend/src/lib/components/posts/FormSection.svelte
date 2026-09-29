<script lang="ts">
  import { X, ClipboardList, Plus } from '@lucide/svelte';
  import type { Form } from '$lib/forms/api';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';

  interface Props {
    selectedFormId: string;
    availableForms: Form[];
    createFormHref: string;
    onBeforeCreateForm?: () => void;
    onRemove: () => void;
  }

  let {
    selectedFormId = $bindable(),
    availableForms,
    createFormHref,
    onBeforeCreateForm,
    onRemove,
  }: Props = $props();

  const pickerTriggerClass =
    'flex w-full items-center justify-between gap-2 rounded-xl border border-cn-border/70 bg-cn-surface px-4 py-3 text-left text-sm font-medium text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';

  const selectedForm = $derived(availableForms.find((f) => f.id === selectedFormId));
  const selectedOpensLater = $derived(
    selectedForm?.opensAt ? formOpensAtIso(selectedForm.opensAt) : null
  );

  function formPriceLabel(form: Form): string {
    if (!form.requiresPayment || !form.basePrice || form.basePrice <= 0) return '';
    const euros = (form.basePrice / 100).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    return ` - ${euros} €`;
  }

  /** "Choose a form" (none linked), then every form the post may carry. */
  const formOptions = $derived<PickerOption[]>([
    { value: '', label: m.post_form_choose_label() },
    ...availableForms.map((form) => ({ value: form.id, label: formOptionLabel(form) })),
  ]);

  function formOptionLabel(form: Form): string {
    const base = `${form.title} (${m.post_form_questions_label({ count: form.items.length })})${formPriceLabel(form)}`;
    if (form.opensAt && formOpensAtIso(form.opensAt)) {
      return `${base} - ${m.post_form_opens_suffix_label({ date: formatFormOpensAt(form.opensAt) })}`;
    }
    return base;
  }
</script>

<div
  class="border-cn-border/60 bg-cn-surface rounded-2xl border p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]"
>
  <div class="mb-4 flex items-center justify-between gap-2">
    <p class="text-text-muted text-2xs flex items-center gap-2 font-bold tracking-widest uppercase">
      <ClipboardList size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      {m.post_form_fallback_title()}
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="ui-icon-button text-text-muted hover:bg-cn-surface hover:text-text-main rounded-full transition-colors"
      title={m.post_form_section_remove_label()}
    >
      <X size={16} />
    </button>
  </div>

  {#if availableForms.length > 0}
    <Picker
      label={m.post_form_fallback_title()}
      value={selectedFormId}
      options={formOptions}
      onValueChange={(v) => (selectedFormId = v)}
      triggerClass={pickerTriggerClass}
    />
    {#if selectedOpensLater && selectedForm?.opensAt}
      <p class="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        {m.post_form_opens_planned_label({ date: formatFormOpensAt(selectedForm.opensAt) })}
      </p>
    {/if}
  {:else}
    <p class="text-text-muted mb-3 text-sm font-medium">{m.post_form_none_yet_label()}</p>
  {/if}

  <a
    href={createFormHref}
    onclick={() => onBeforeCreateForm?.()}
    class="text-cn-yellow mt-3 inline-flex items-center gap-1.5 text-xs font-bold hover:underline"
  >
    <Plus size={14} strokeWidth={2.5} />
    {m.post_form_create_new_label()}
  </a>
</div>
