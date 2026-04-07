<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import {
    getForm,
    submitForm as submitFormService,
    checkSubmission,
    getSubmission,
    type Form,
    type FormItem,
  } from '$lib/forms/api';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import { ArrowLeft, ClipboardList, Check, Send } from 'lucide-svelte';

  const formId = $derived(page.params.id);
  const redirectTo = $derived(page.url.searchParams.get('redirect') || '/posts');

  let form = $state<Form | null>(null);
  let selections = $state<Record<string, any>>({});
  let submitted = $state(false);
  let loading = $state(true);
  let error = $state('');
  let successMessage = $state('');
  let userId = $state('');

  onMount(async () => {
    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      try {
        await getToken();
      } catch (e) {
        console.error('Failed to get token', e);
      }
    }

    try {
      const id = formId;
      if (!id) {
        error = 'Formulaire introuvable.';
        loading = false;
        return;
      }
      const f = await getForm(id);
      form = f;
      initSelections(f.items);

      const { hasSubmitted } = await checkSubmission(f.id);
      submitted = hasSubmitted;
      if (hasSubmitted) {
        try {
          const sub = await getSubmission(f.id);
          if (sub?.answers) selections = sub.answers;
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      error = e.message || 'Impossible de charger le formulaire.';
    } finally {
      loading = false;
    }
  });

  function initSelections(items: FormItem[]) {
    const initial: Record<string, any> = {};
    for (const item of items) {
      if (item.type === 'multiple_choice') {
        initial[item.id] = [];
      } else if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
        initial[item.id] = {};
        for (const row of item.rows ?? []) {
          initial[item.id][row] = item.type === 'matrix_multiple' ? [] : '';
        }
      } else {
        initial[item.id] = '';
      }
    }
    selections = initial;
  }

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (amountCents === undefined) return '';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }

  function calculateTotal(): number {
    if (!form) return 0;
    let total = form.basePrice;
    for (const item of form.items) {
      const val = selections[item.id];
      if (!val) continue;
      if (['single_choice', 'dropdown'].includes(item.type)) {
        const opt = item.options?.find((o) => o.id === val);
        if (opt) total += opt.priceModifier;
      } else if (item.type === 'multiple_choice' && Array.isArray(val)) {
        for (const id of val) {
          const opt = item.options?.find((o) => o.id === id);
          if (opt) total += opt.priceModifier;
        }
      }
    }
    return Math.max(0, total);
  }

  async function handleSubmit() {
    if (!form) return;
    if (!userId.trim()) {
      error = 'Veuillez vous connecter pour soumettre.';
      return;
    }

    // Validation
    for (const item of form.items) {
      const val = selections[item.id];
      if (item.required) {
        if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
          if (!val) {
            error = `Veuillez compléter toutes les lignes pour « ${item.label} »`;
            return;
          }
          for (const row of item.rows ?? []) {
            const rowVal = val[row];
            if (
              rowVal === undefined ||
              rowVal === null ||
              rowVal === '' ||
              (Array.isArray(rowVal) && rowVal.length === 0)
            ) {
              error = `Veuillez compléter la ligne « ${row} » dans « ${item.label} »`;
              return;
            }
          }
        } else if (Array.isArray(val)) {
          if (val.length === 0) {
            error = `Veuillez sélectionner une option pour « ${item.label} »`;
            return;
          }
        } else if (!val) {
          error = `Veuillez répondre à « ${item.label} »`;
          return;
        }
      }
    }

    error = '';
    try {
      const res = await submitFormService(form.id, {
        email: '',
        answers: selections,
      });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        submitted = true;
        successMessage = res.message || 'Réponse envoyée !';
        setTimeout(() => goto(redirectTo), 1500);
      }
    } catch (e: any) {
      error = e.message || 'Échec de la soumission.';
    }
  }
</script>

<div class="min-h-screen bg-cn-dark/5">
  <div class="max-w-2xl mx-auto px-4 py-8">
    <!-- Back button -->
    <button
      class="inline-flex items-center gap-2 text-sm font-semibold text-text-muted hover:text-cn-dark transition-colors mb-6"
      onclick={() => goto(redirectTo)}
    >
      <ArrowLeft size={16} />
      Retour
    </button>

    {#if loading}
      <Card class="p-8 text-center">
        <p class="text-text-muted">Chargement du formulaire…</p>
      </Card>
    {:else if error && !form}
      <Card class="p-8 text-center">
        <p class="text-red-600 font-semibold">{error}</p>
        <button
          class="mt-4 text-sm text-text-muted hover:underline"
          onclick={() => goto(redirectTo)}
        >
          Retour
        </button>
      </Card>
    {:else if form}
      <!-- Header -->
      <Card class="mb-6">
        <div class="flex items-start gap-4 p-5">
          <div class="p-3 rounded-2xl bg-cn-yellow/15 text-cn-dark shrink-0">
            <ClipboardList size={24} />
          </div>
          <div class="flex-1">
            <h1 class="text-2xl font-bold text-text-main">{form.title}</h1>
            {#if form.description}
              <p class="text-text-muted mt-1">{form.description}</p>
            {/if}
            {#if form.basePrice > 0}
              <span
                class="inline-block mt-2 text-xs font-semibold text-cn-dark bg-cn-yellow/20 px-2 py-0.5 rounded-full"
              >
                Base : {formatCurrency(form.basePrice, form.currency)}
              </span>
            {/if}
          </div>
          {#if submitted}
            <div class="p-2 rounded-xl bg-green-100 text-green-600 shrink-0">
              <Check size={20} />
            </div>
          {/if}
        </div>
      </Card>

      {#if successMessage}
        <Card class="mb-6">
          <div class="p-5 flex items-center gap-3">
            <div class="p-2 rounded-xl bg-green-100 text-green-600">
              <Check size={20} />
            </div>
            <div>
              <p class="font-bold text-green-700">{successMessage}</p>
              <p class="text-xs text-text-muted mt-0.5">Redirection…</p>
            </div>
          </div>
        </Card>
      {/if}

      <!-- Form fields -->
      <Card>
        <div class="p-5 space-y-5">
          {#each form.items as item (item.id)}
            <div class="space-y-2">
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="block text-sm font-bold text-text-main ml-1">
                {item.label}
                {#if item.required}<span class="text-red-500 ml-0.5">*</span>{/if}
              </label>

              {#if item.type === 'short_text'}
                <input
                  type="text"
                  class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-[var(--cn-surface)] outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] disabled:opacity-50 disabled:bg-cn-border/20"
                  bind:value={selections[item.id]}
                  placeholder="Votre réponse"
                  disabled={submitted}
                />
              {:else if item.type === 'long_text'}
                <textarea
                  rows="3"
                  class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-[var(--cn-surface)] outline-none transition-all resize-y placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] disabled:opacity-50 disabled:bg-cn-border/20"
                  bind:value={selections[item.id]}
                  placeholder="Votre réponse"
                  disabled={submitted}
                ></textarea>
              {:else if item.type === 'dropdown' || item.type === 'single'}
                <select
                  class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-[var(--cn-surface)] outline-none transition-all appearance-none focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] disabled:opacity-50 disabled:bg-cn-border/20"
                  bind:value={selections[item.id]}
                  disabled={submitted}
                >
                  <option value="" disabled selected>Choisir une option…</option>
                  {#each item.options ?? [] as opt (opt.id)}
                    <option value={opt.id}>
                      {opt.label}
                      {#if opt.priceModifier > 0}
                        (+{formatCurrency(opt.priceModifier, form.currency)})
                      {:else if opt.priceModifier < 0}
                        ({formatCurrency(opt.priceModifier, form.currency)})
                      {/if}
                    </option>
                  {/each}
                </select>
              {:else if item.type === 'single_choice'}
                <div class="space-y-2 mt-1">
                  {#each item.options ?? [] as opt (opt.id)}
                    <label
                      class="flex items-center gap-3 p-3 rounded-2xl border-2 transition-all cursor-pointer select-none
                      {selections[item.id] === opt.id
                        ? 'border-cn-yellow bg-cn-yellow/5'
                        : 'border-cn-border hover:border-cn-yellow/50 bg-[var(--cn-surface)]'}
                      {submitted ? 'opacity-60 cursor-not-allowed' : ''}"
                    >
                      <input
                        type="radio"
                        name={`radio-${form.id}-${item.id}`}
                        value={opt.id}
                        bind:group={selections[item.id]}
                        class="h-4 w-4 accent-cn-yellow"
                        disabled={submitted}
                      />
                      <span class="text-sm text-text-main font-medium">
                        {opt.label}
                        {#if opt.priceModifier !== 0}
                          <span
                            class="text-text-muted text-xs font-mono ml-1 bg-cn-border/30 px-1.5 py-0.5 rounded-lg"
                          >
                            {opt.priceModifier > 0 ? '+' : ''}{formatCurrency(
                              opt.priceModifier,
                              form.currency
                            )}
                          </span>
                        {/if}
                      </span>
                    </label>
                  {/each}
                </div>
              {:else if item.type === 'multiple_choice'}
                <div class="space-y-2 mt-1">
                  {#each item.options ?? [] as opt (opt.id)}
                    <label
                      class="flex items-center gap-3 p-3 rounded-2xl border-2 transition-all cursor-pointer select-none
                      {(selections[item.id] ?? []).includes(opt.id)
                        ? 'border-cn-yellow bg-cn-yellow/5'
                        : 'border-cn-border hover:border-cn-yellow/50 bg-[var(--cn-surface)]'}
                      {submitted ? 'opacity-60 cursor-not-allowed' : ''}"
                    >
                      <input
                        type="checkbox"
                        value={opt.id}
                        bind:group={selections[item.id]}
                        class="h-4 w-4 accent-cn-yellow"
                        disabled={submitted}
                      />
                      <span class="text-sm text-text-main font-medium">
                        {opt.label}
                        {#if opt.priceModifier !== 0}
                          <span
                            class="text-text-muted text-xs font-mono ml-1 bg-cn-border/30 px-1.5 py-0.5 rounded-lg"
                          >
                            {opt.priceModifier > 0 ? '+' : ''}{formatCurrency(
                              opt.priceModifier,
                              form.currency
                            )}
                          </span>
                        {/if}
                      </span>
                    </label>
                  {/each}
                </div>
              {:else if item.type === 'linear_scale'}
                <div class="py-3">
                  <div
                    class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-wider mb-2 px-1"
                  >
                    <span>{item.scale?.minLabel || item.scale?.min}</span>
                    <span>{item.scale?.maxLabel || item.scale?.max}</span>
                  </div>
                  <div
                    class="flex justify-between items-center gap-1.5 p-2 rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)]"
                  >
                    {#each Array.from({ length: (item.scale?.max || 5) - (item.scale?.min || 1) + 1 }, (_, i) => (item.scale?.min || 1) + i) as val (val)}
                      <label
                        class="flex flex-col items-center gap-2 cursor-pointer flex-1 group
                        {submitted ? 'cursor-not-allowed opacity-60' : ''}"
                      >
                        <input
                          type="radio"
                          name={`scale-${form.id}-${item.id}`}
                          value={val}
                          bind:group={selections[item.id]}
                          class="h-5 w-5 accent-cn-yellow"
                          disabled={submitted}
                        />
                        <span
                          class="text-xs font-bold text-text-muted group-hover:text-cn-dark transition-colors"
                          >{val}</span
                        >
                      </label>
                    {/each}
                  </div>
                </div>
              {:else if ['matrix_single', 'matrix_multiple'].includes(item.type)}
                <div class="overflow-x-auto mt-1 rounded-2xl border-2 border-cn-border">
                  <table class="w-full text-sm border-separate border-spacing-0">
                    <thead>
                      <tr>
                        <th
                          class="w-1/3 min-w-[120px] sticky left-0 bg-[var(--cn-surface)] z-10 p-3"
                        ></th>
                        {#each item.options ?? [] as col (col.id)}
                          <th
                            class="px-2 py-3 text-center font-bold text-xs text-text-muted uppercase min-w-[80px]"
                            >{col.label}</th
                          >
                        {/each}
                      </tr>
                    </thead>
                    <tbody>
                      {#each item.rows || [] as row (row)}
                        <tr class="group hover:bg-cn-border/10 transition-colors">
                          <td
                            class="py-3 px-3 font-medium text-text-main sticky left-0 bg-[var(--cn-surface)] group-hover:bg-cn-border/10 z-10 border-t border-cn-border"
                            >{row}</td
                          >
                          {#each item.options ?? [] as col (col.id)}
                            <td class="text-center py-3 border-t border-cn-border">
                              <div class="flex justify-center">
                                {#if item.type === 'matrix_single'}
                                  <input
                                    type="radio"
                                    name={`matrix-${form.id}-${item.id}-${row}`}
                                    value={col.id}
                                    bind:group={selections[item.id][row]}
                                    class="h-4 w-4 accent-cn-yellow"
                                    disabled={submitted}
                                  />
                                {:else}
                                  <input
                                    type="checkbox"
                                    value={col.id}
                                    bind:group={selections[item.id][row]}
                                    class="h-4 w-4 accent-cn-yellow"
                                    disabled={submitted}
                                  />
                                {/if}
                              </div>
                            </td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else}
                <div class="p-3 bg-red-50 text-red-600 text-xs rounded-2xl border-2 border-red-200">
                  Type non supporté : <strong>{item.type}</strong>
                </div>
              {/if}
            </div>
          {/each}

          <!-- Error -->
          {#if error}
            <div
              class="p-3 rounded-xl bg-red-50 text-red-600 text-sm font-medium border border-red-100"
            >
              {error}
            </div>
          {/if}

          <!-- Footer: total + submit -->
          <div class="pt-4 mt-2 border-t-2 border-cn-border flex items-center justify-between">
            <div class="font-bold text-lg text-cn-dark">
              Total : {formatCurrency(calculateTotal(), form.currency)}
              {#if submitted}
                <span class="text-xs font-semibold text-green-600 ml-2">(Déjà envoyé)</span>
              {/if}
            </div>
            <Button variant="primary" class="px-6" disabled={submitted} onclick={handleSubmit}>
              {#if submitted}
                Envoyé
                <Check size={16} class="ml-1" />
              {:else}
                {form.submitLabel || 'Envoyer'}
                <Send size={16} class="ml-1" />
              {/if}
            </Button>
          </div>
        </div>
      </Card>
    {/if}
  </div>
</div>
