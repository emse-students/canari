<script lang="ts">
  import { X, ClipboardList, ChevronDown, Plus } from '@lucide/svelte';
  import type { Form } from '$lib/forms/api';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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

  const selectPlainClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 px-4 pr-10 py-3 text-sm font-medium text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  const chevronWrapClass =
    'pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted';

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

  function formOptionLabel(form: Form): string {
    const base = `${form.title} (${m.post_form_questions_label({ count: form.items.length })})${formPriceLabel(form)}`;
    if (form.opensAt && formOpensAtIso(form.opensAt)) {
      return `${base} - ${m.post_form_opens_suffix_label({ date: formatFormOpensAt(form.opensAt) })}`;
    }
    return base;
  }
</script>

<div
  class="rounded-2xl border border-cn-border/60 bg-cn-surface/70 dark:bg-black/25 p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]"
>
  <div class="mb-4 flex items-center justify-between gap-2">
    <p
      class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted"
    >
      <ClipboardList size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      {m.post_form_fallback_title()}
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
      title={m.post_form_section_remove_label()}
    >
      <X size={16} />
    </button>
  </div>

  {#if availableForms.length > 0}
    <div class="relative">
      <select bind:value={selectedFormId} class={selectPlainClass}>
        <option value="">{m.post_form_choose_label()}</option>
        {#each availableForms as form (form.id)}
          <option value={form.id}>{formOptionLabel(form)}</option>
        {/each}
      </select>
      <div class={chevronWrapClass}>
        <ChevronDown size={18} strokeWidth={2} />
      </div>
    </div>
    {#if selectedOpensLater && selectedForm?.opensAt}
      <p class="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        {m.post_form_opens_planned_label({ date: formatFormOpensAt(selectedForm.opensAt) })}
      </p>
    {/if}
  {:else}
    <p class="mb-3 text-sm font-medium text-text-muted">{m.post_form_none_yet_label()}</p>
  {/if}

  <a
    href={createFormHref}
    onclick={() => onBeforeCreateForm?.()}
    class="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-cn-yellow hover:underline"
  >
    <Plus size={14} strokeWidth={2.5} />
    {m.post_form_create_new_label()}
  </a>
</div>
