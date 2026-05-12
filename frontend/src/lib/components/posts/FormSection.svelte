<script lang="ts">
  import { X, ClipboardList, ChevronDown } from 'lucide-svelte';
  import type { Form } from '$lib/forms/api';

  /**
   * Collapsible card that lets the author attach a pre-built form to a post.
   * Rendered inside CreatePostForm when the "Formulaire" toolbar button is active
   * and the user has not already added an event button (forms and events are mutually exclusive).
   */
  interface Props {
    /** ID of the selected form. Bindable — parent owns the state. */
    selectedFormId: string;
    /** Available forms pre-loaded from the API. */
    availableForms: Form[];
    /** Called when the user clicks the remove (✕) button. */
    onRemove: () => void;
  }

  let { selectedFormId = $bindable(), availableForms, onRemove }: Props = $props();

  const selectPlainClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 px-4 pr-10 py-3 text-sm font-medium text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  const chevronWrapClass =
    'pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted';
</script>

<div class="rounded-2xl border border-cn-border/60 bg-cn-surface/70 dark:bg-black/25 p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]">
  <!-- Header row -->
  <div class="mb-4 flex items-center justify-between gap-2">
    <p class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted">
      <ClipboardList size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      Formulaire
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
      title="Retirer le formulaire"
    >
      <X size={16} />
    </button>
  </div>

  {#if availableForms.length === 0}
    <div class="rounded-xl bg-cn-surface/60 p-4 text-center dark:bg-white/5">
      <p class="text-sm font-medium text-text-muted">Aucun formulaire disponible.</p>
      <a href="/forms/create" class="mt-2 inline-block text-xs font-bold text-cn-yellow hover:underline">
        Créer un formulaire
      </a>
    </div>
  {:else}
    <div class="relative">
      <select bind:value={selectedFormId} class={selectPlainClass}>
        <option value="">— Choisir un formulaire —</option>
        {#each availableForms as form (form.id)}
          <option value={form.id}>{form.title} ({form.items.length} questions)</option>
        {/each}
      </select>
      <div class={chevronWrapClass}>
        <ChevronDown size={18} strokeWidth={2} />
      </div>
    </div>
  {/if}
</div>
