<script lang="ts">
  import { X, CalendarCheck, ChevronDown, Plus } from 'lucide-svelte';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import { slide } from 'svelte/transition';
  import Input from '$lib/components/ui/Input.svelte';
  import type { Form } from '$lib/forms/api';

  /**
   * Collapsible card that lets the author configure an event registration button.
   * Supports capacity limits and optional Stripe payment.
   * Rendered inside CreatePostForm when the user clicks the "Événement" toolbar button.
   */
  interface Props {
    /** Text shown on the registration button. Bindable. */
    label: string;
    /** Unique event identifier (used to track registrations). Bindable. */
    eventId: string;
    /** Whether registration requires payment via Stripe. Bindable. */
    requiresPayment: boolean;
    /** Price in euros — converted to cents on submit. Bindable. */
    amount: number;
    /** ISO currency code, defaults to "eur". Bindable. */
    currency: string;
    /** Maximum number of registrants (0 = unlimited). Bindable. */
    capacity: number;
    /** Optional form to show after a successful free registration. Bindable. */
    formId: string;
    /** Available forms pre-loaded from the API. */
    availableForms: Form[];
    createFormHref: string;
    onBeforeCreateForm?: () => void;
    /** Called when the user clicks the remove (✕) button. */
    onRemove: () => void;
  }

  let {
    label = $bindable(),
    eventId = $bindable(),
    requiresPayment = $bindable(),
    amount = $bindable(),
    currency = $bindable(),
    capacity = $bindable(),
    formId = $bindable(),
    availableForms,
    createFormHref,
    onBeforeCreateForm,
    onRemove,
  }: Props = $props();

  function formOptionLabel(form: Form): string {
    const base = form.title;
    if (form.opensAt && formOpensAtIso(form.opensAt)) {
      return `${base} — ouvre ${formatFormOpensAt(form.opensAt)}`;
    }
    return base;
  }

  const selectPlainClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 px-4 pr-10 py-3 text-sm font-medium text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  const chevronWrapClass =
    'pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted';
</script>

<div class="rounded-2xl border border-cn-border/60 bg-cn-surface/70 dark:bg-black/25 p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]">
  <!-- Header row -->
  <div class="mb-4 flex items-center justify-between gap-2">
    <p class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted">
      <CalendarCheck size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      Bouton d'événement
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
      title="Retirer l'événement"
    >
      <X size={16} />
    </button>
  </div>

  <div class="space-y-4">
    <!-- Label + event ID -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Input label="Libellé du bouton" bind:value={label} placeholder="Ex: S'inscrire à l'AgA" />
      <Input label="ID unique de l'événement" bind:value={eventId} placeholder="ex: wei-2026" />
    </div>

    <!-- Capacity + payment toggle -->
    <div class="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
      <Input type="number" label="Capacité max (places)" bind:value={capacity as unknown as string} />
      <label class="flex h-[46px] cursor-pointer select-none items-center justify-between rounded-xl bg-cn-surface/80 px-4 py-3 transition-colors hover:bg-cn-border/30 dark:bg-white/5 dark:hover:bg-white/10 sm:mb-[2px]">
        <span class="text-sm font-semibold text-text-main">Inscription payante</span>
        <div class="relative flex items-center">
          <input type="checkbox" bind:checked={requiresPayment} class="peer sr-only" />
          <div class="h-6 w-11 rounded-full bg-black/15 shadow-inner transition-colors duration-300 peer-checked:bg-cn-yellow dark:bg-white/20"></div>
          <div class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5"></div>
        </div>
      </label>
    </div>

    <!-- Payment details (shown only when requiresPayment) -->
    {#if requiresPayment}
      <div
        class="grid grid-cols-2 gap-4 rounded-xl border border-cn-yellow/25 bg-cn-yellow/5 p-4"
        transition:slide={{ duration: 200 }}
      >
        <Input type="number" label="Montant (€)" bind:value={amount as unknown as string} step="0.01" />
        <Input label="Devise" bind:value={currency} placeholder="eur" />
      </div>
    {/if}

    <!-- Optional linked form -->
    <div class="pt-1">
        <label
          for="event-form-select"
          class="ml-1 mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider text-text-muted"
        >
          Formulaire lié (optionnel)
        </label>
      {#if availableForms.length > 0}
        <div class="relative">
          <select id="event-form-select" bind:value={formId} class={selectPlainClass}>
            <option value="">— Aucun —</option>
            {#each availableForms as form (form.id)}
              <option value={form.id}>{formOptionLabel(form)}</option>
            {/each}
          </select>
          <div class={chevronWrapClass}>
            <ChevronDown size={18} strokeWidth={2} />
          </div>
        </div>
      {/if}
      <a
        href={createFormHref}
        onclick={() => onBeforeCreateForm?.()}
        class="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-cn-yellow hover:underline"
      >
        <Plus size={14} strokeWidth={2.5} />
        Créer un nouveau formulaire
      </a>
    </div>
  </div>
</div>
