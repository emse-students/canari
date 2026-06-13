<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { getToken } from '$lib/stores/auth';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    currentUserId,
    listPaymentMethods,
    chargeWithSavedMethod,
    setupPaymentMethod,
    type PaymentMethod,
  } from '$lib/stores/user';
  import {
    getForm,
    submitForm as submitFormService,
    checkSubmission,
    getSubmission,
    cancelPendingSubmission,
    type Form,
    type FormItem,
  } from '$lib/forms/api';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    getCalendarEventLinkedToForm,
    getAssociation,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { useFormReminder } from '$lib/posts/useFormReminder.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PaymentModal from '$lib/components/ui/PaymentModal.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import {
    ArrowLeft,
    ClipboardList,
    Check,
    CalendarDays,
    Bell,
    BellOff,
    CreditCard,
    Link,
  } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';

  const formId = $derived(page.params.id);
  const redirectTo = $derived(page.url.searchParams.get('redirect') || '/posts');

  let form = $state<Form | null>(null);
  const opensLaterIso = $derived(form?.opensAt ? formOpensAtIso(form.opensAt) : null);
  const isNotOpenYet = $derived(!!opensLaterIso);
  const reminder = useFormReminder(page.params.id ?? '');
  let selections = $state<Record<string, any>>({});
  let submitted = $state(false);
  let paymentPending = $state(false);
  let formFull = $state(false);
  let memberPricing = $state(false);
  let submitting = $state(false);
  let savingCard = $state(false);
  let loading = $state(true);
  let error = $state('');
  let successMessage = $state('');
  let userId = $state('');

  // Payment
  let paymentMethods = $state<PaymentMethod[]>([]);
  let showPaymentModal = $state(false);
  let pendingCheckoutUrl = $state('');
  let pendingSubmissionId = $state('');
  let linkedAgendaEvent = $state<AssociationCalendarEvent | null>(null);
  let agendaAssociationSlug = $state('');
  let paymentMethodChoice = $state<'stripe' | 'cash'>('stripe');
  let copiedLink = $state(false);

  async function handleSaveCard() {
    savingCard = true;
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const current = `${origin}/forms/${formId}`;
      const result = await setupPaymentMethod({ successUrl: current, cancelUrl: current });
      if (result.url) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(result.url);
      }
    } catch (err: unknown) {
      showToast(
        err instanceof Error ? err.message : "Impossible de démarrer l'enregistrement de carte"
      );
    } finally {
      savingCard = false;
    }
  }

  function copyFormLink() {
    void copyPublicShareLink(`/forms/${formId}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

  onMount(async () => {
    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      await getToken().catch(() => {
        // Silently ignore - the form loads fine without a pre-fetched token;
        // apiFetch will retry on the first API call.
      });
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

      linkedAgendaEvent = null;
      agendaAssociationSlug = '';
      try {
        const { linkedEvent } = await getCalendarEventLinkedToForm(f.id);
        linkedAgendaEvent = linkedEvent;
        if (linkedEvent) {
          try {
            const asso = await getAssociation(linkedEvent.associationId);
            agendaAssociationSlug = asso.slug;
          } catch {
            agendaAssociationSlug = '';
          }
        }
      } catch {
        linkedAgendaEvent = null;
      }

      const {
        hasSubmitted,
        paymentStatus,
        formFull: full,
        memberPricing: isMember,
      } = await checkSubmission(f.id);
      submitted = hasSubmitted;
      formFull = full;
      memberPricing = isMember;
      paymentPending = hasSubmitted && paymentStatus === 'pending';

      if (!hasSubmitted && formOpensAtIso(f.opensAt)) {
        void reminder.load();
      }
      if (hasSubmitted) {
        try {
          const sub = await getSubmission(f.id);
          if (sub?.answers) selections = sub.answers;
        } catch {
          // ignore
        }
      }

      // Pre-load saved payment methods for paid forms
      if (f.requiresPayment && userId) {
        try {
          const methods = await listPaymentMethods();
          paymentMethods = methods;
          // Attempt to get the customer ID to pass to checkout for future-save
          // It's stored server-side; we don't expose it directly, but the backend will use it
        } catch {
          // Stripe may not be configured
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

  /** Questions that pass their conditional display check. */
  const visibleItems = $derived.by(() => {
    if (!form) return [];
    return form.items.filter((item) => {
      if (!item.dependsOn) return true;
      const dep = selections[item.dependsOn];
      if (dep === undefined || dep === null || dep === '') return false;
      if (Array.isArray(dep)) return (dep as string[]).includes(item.dependsValue ?? '');
      return String(dep) === (item.dependsValue ?? '');
    });
  });

  function effectiveBasePrice(f: Form): number {
    if (memberPricing && f.basePriceMember != null) return f.basePriceMember;
    return f.basePrice ?? 0;
  }

  function optionModifier(opt: { priceModifier: number; priceModifierMember?: number }): number {
    if (memberPricing && opt.priceModifierMember != null) return opt.priceModifierMember;
    return opt.priceModifier;
  }

  function calculateTotal(): number {
    if (!form) return 0;
    let total = effectiveBasePrice(form);
    for (const item of visibleItems) {
      const val = selections[item.id];
      if (!val) continue;
      if (['single_choice', 'dropdown'].includes(item.type)) {
        const opt = item.options?.find((o) => o.id === val);
        if (opt) total += optionModifier(opt);
      } else if (item.type === 'multiple_choice' && Array.isArray(val)) {
        for (const id of val) {
          const opt = item.options?.find((o) => o.id === id);
          if (opt) total += optionModifier(opt);
        }
      }
    }
    return Math.max(0, total);
  }

  async function handleSubmit() {
    if (!form || submitting) return;
    if (isNotOpenYet && form.opensAt) {
      error = `Ce formulaire ouvre le ${formatFormOpensAt(form.opensAt)}.`;
      return;
    }
    if (!userId.trim()) {
      error = 'Veuillez vous connecter pour soumettre.';
      return;
    }

    // Validation - only validate visible (non-conditional-hidden) questions
    for (const item of visibleItems) {
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
    submitting = true;
    try {
      const { formCheckoutCallbacks } = await import('$lib/utils/stripeCallbacks');
      const total = calculateTotal();
      // Only submit answers for visible questions
      const visibleIds = new Set(visibleItems.map((i) => i.id));
      const visibleAnswers = Object.fromEntries(
        Object.entries(selections).filter(([id]) => visibleIds.has(id))
      );
      const res = await submitFormService(form.id, {
        email: '',
        answers: visibleAnswers,
        ...formCheckoutCallbacks(),
        ...(total > 0 && form.allowCashPayment ? { paymentMethod: paymentMethodChoice } : {}),
      });
      if (res.checkoutUrl) {
        // Payment required - check if user has saved payment methods
        if (paymentMethods.length > 0 && res.submissionId) {
          pendingCheckoutUrl = res.checkoutUrl;
          pendingSubmissionId = res.submissionId;
          showPaymentModal = true;
        } else {
          const { navigateExternal } = await import('$lib/utils/openExternal');
          await navigateExternal(res.checkoutUrl);
        }
      } else {
        submitted = true;
        successMessage = res.message || 'Réponse envoyée !';
        setTimeout(() => goto(redirectTo), 1500);
      }
    } catch (e: any) {
      error = e.message || 'Échec de la soumission.';
    } finally {
      submitting = false;
    }
  }

  async function handlePayWithSaved(paymentMethodId: string) {
    const result = await chargeWithSavedMethod(pendingSubmissionId, paymentMethodId);
    if (result.ok) {
      submitted = true;
      successMessage = 'Paiement effectué avec succès !';
      showPaymentModal = false;
      setTimeout(() => goto(redirectTo), 1500);
    }
    // If requiresAction, PaymentModal handles 3DS inline and calls onSuccess
    return result;
  }

  function handlePaySuccess() {
    submitted = true;
    successMessage = 'Paiement effectué avec succès !';
    showPaymentModal = false;
    setTimeout(() => goto(redirectTo), 1500);
  }

  async function handlePayWithNew() {
    showPaymentModal = false;
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(pendingCheckoutUrl);
  }

  async function handlePaymentFailed() {
    if (!pendingSubmissionId) return;
    try {
      await cancelPendingSubmission(pendingSubmissionId);
    } catch {
      // charge-saved-method may have already cancelled server-side
    }
    pendingSubmissionId = '';
    pendingCheckoutUrl = '';
    showPaymentModal = false;
    error = 'Le paiement a échoué. Vous pouvez soumettre à nouveau le formulaire.';
  }

  // ── Progress bar ─────────────────────────────────────────────────
  const totalCount = $derived(visibleItems.length);
  const answeredCount = $derived.by(() => {
    if (!form) return 0;
    return visibleItems.filter((item) => {
      const val = selections[item.id];
      if (item.type === 'multiple_choice') return Array.isArray(val) && val.length > 0;
      if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
        if (!val || typeof val !== 'object') return false;
        return (item.rows ?? []).every((row) => {
          const rv = (val as Record<string, any>)[row];
          return (
            rv !== '' && rv !== undefined && rv !== null && (!Array.isArray(rv) || rv.length > 0)
          );
        });
      }
      return val !== '' && val !== undefined && val !== null;
    }).length;
  });
  const progressPct = $derived(totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0);
</script>

{#if showPaymentModal && pendingSubmissionId}
  <PaymentModal
    {paymentMethods}
    totalCents={calculateTotal()}
    currency={form?.currency ?? 'eur'}
    onPayWithSaved={handlePayWithSaved}
    onPayWithNew={handlePayWithNew}
    onSuccess={handlePaySuccess}
    onPaymentFailed={handlePaymentFailed}
    onClose={() => (showPaymentModal = false)}
  />
{/if}

<div class="max-w-2xl mx-auto px-4 pt-6 pb-36">
  <!-- Back + Share -->
  <div class="flex items-center justify-between mb-6">
    <button
      class="inline-flex items-center gap-1.5 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
      onclick={() => goto(redirectTo)}
    >
      <ArrowLeft size={15} />
      Retour
    </button>
    {#if form}
      <button
        type="button"
        onclick={copyFormLink}
        class="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl transition-colors {copiedLink
          ? 'text-green-600 bg-green-50 dark:bg-green-950/20'
          : 'text-text-muted hover:text-text-main hover:bg-cn-border/30'}"
      >
        {#if copiedLink}
          <Check size={13} />Lien copié !
        {:else}
          <Link size={13} />Partager
        {/if}
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-24">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error && !form}
    <div
      class="rounded-3xl border border-cn-border bg-[var(--cn-surface)] p-10 text-center space-y-3"
    >
      <p class="text-red-600 font-semibold">{error}</p>
      <button class="text-sm text-text-muted hover:underline" onclick={() => goto(redirectTo)}
        >Retour</button
      >
    </div>
  {:else if form}
    <!-- ── Header ── -->
    <div
      class="rounded-3xl overflow-hidden border border-cn-border bg-[var(--cn-surface)] shadow-sm mb-5"
    >
      {#if form.imageUrl}
        <div class="relative">
          <img src={form.imageUrl} alt="" class="w-full max-h-72 object-cover" loading="lazy" />
          <div
            class="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/60 to-transparent"
          ></div>
          <div class="absolute bottom-0 inset-x-0 p-5 flex items-end gap-3">
            <div class="flex-1 min-w-0">
              <h1 class="text-2xl font-extrabold text-white leading-tight">{form.title}</h1>
              {#if effectiveBasePrice(form) > 0}
                <span
                  class="inline-block mt-1.5 text-xs font-bold bg-cn-yellow text-cn-ink px-2.5 py-1 rounded-full"
                >
                  À partir de {formatCurrency(effectiveBasePrice(form), form.currency)}
                  {#if memberPricing}(cotisant){/if}
                </span>
              {/if}
            </div>
            {#if submitted}
              <div class="p-2 rounded-xl bg-green-500 text-white shrink-0">
                <Check size={20} />
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div
          class="bg-gradient-to-br from-cn-yellow/10 via-transparent to-transparent px-6 pt-6 pb-4 flex items-start gap-4"
        >
          <div class="p-3 rounded-2xl bg-cn-yellow/20 text-cn-dark shrink-0">
            <ClipboardList size={26} />
          </div>
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-extrabold text-text-main leading-tight">{form.title}</h1>
            {#if effectiveBasePrice(form) > 0}
              <span
                class="inline-block mt-1.5 text-xs font-bold bg-cn-yellow text-cn-ink px-2.5 py-1 rounded-full"
              >
                À partir de {formatCurrency(effectiveBasePrice(form), form.currency)}
                {#if memberPricing}(cotisant){/if}
              </span>
            {/if}
          </div>
          {#if submitted}
            <div class="p-2 rounded-xl bg-green-100 text-green-600 shrink-0">
              <Check size={20} />
            </div>
          {/if}
        </div>
      {/if}
      {#if form.description?.trim()}
        <div class="px-6 py-4 border-t border-cn-border/60">
          <ProfileBioMarkdown source={form.description} />
        </div>
      {/if}
    </div>

    <!-- ── Progress bar ── -->
    {#if !submitted && totalCount > 0}
      <div class="flex items-center gap-3 mb-5">
        <div class="flex-1 h-2 bg-cn-border/60 rounded-full overflow-hidden">
          <div
            class="h-full bg-cn-yellow rounded-full transition-all duration-500"
            style="width:{progressPct}%"
          ></div>
        </div>
        <span class="text-xs font-bold text-text-muted tabular-nums shrink-0">
          {answeredCount} / {totalCount}
        </span>
      </div>
    {/if}

    <!-- ── Linked agenda event ── -->
    {#if linkedAgendaEvent}
      <a
        href={agendaAssociationSlug
          ? `/associations/${encodeURIComponent(agendaAssociationSlug)}`
          : '/associations'}
        class="flex items-center gap-3 rounded-2xl border border-cn-yellow/35 bg-cn-yellow/10 px-4 py-3 mb-4 transition-colors hover:bg-cn-yellow/15"
      >
        <div class="rounded-xl bg-cn-yellow/25 p-2 text-cn-dark shrink-0">
          <CalendarDays size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-bold uppercase tracking-wide text-text-muted">Événement lié</p>
          <p class="text-sm font-semibold text-text-main truncate">{linkedAgendaEvent.title}</p>
        </div>
        <span class="text-xs font-semibold text-cn-dark shrink-0">Voir →</span>
      </a>
    {/if}

    <!-- ── Not open yet ── -->
    {#if isNotOpenYet && form.opensAt}
      <div
        class="rounded-2xl border border-amber-300/60 bg-amber-50/80 dark:bg-amber-950/20 px-4 py-4 mb-4 flex items-center justify-between gap-4"
      >
        <p class="text-sm font-semibold text-amber-800 dark:text-amber-300">
          Ouverture le {formatFormOpensAt(form.opensAt)}
        </p>
        {#if reminder.loaded}
          <button
            type="button"
            onclick={reminder.toggle}
            disabled={reminder.toggling}
            class="flex items-center gap-1.5 text-xs font-bold shrink-0 px-3 py-2 rounded-xl transition-colors {reminder.subscribed
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-amber-200/60 text-amber-900 dark:text-amber-300 hover:bg-amber-200'}"
          >
            {#if reminder.subscribed}
              <BellOff size={13} />Rappel activé
            {:else}
              <Bell size={13} />Me prévenir
            {/if}
          </button>
        {/if}
      </div>
    {/if}

    <!-- ── Success ── -->
    {#if successMessage}
      <div
        class="rounded-2xl border border-green-200 bg-green-50 dark:bg-green-950/20 px-5 py-4 mb-4 flex items-center gap-3"
      >
        <div class="p-2 rounded-xl bg-green-100 dark:bg-green-900/40 text-green-600 shrink-0">
          <Check size={20} />
        </div>
        <div>
          <p class="font-bold text-green-700 dark:text-green-300">{successMessage}</p>
          <p class="text-xs text-green-600/70 dark:text-green-400/70 mt-0.5">
            Redirection en cours…
          </p>
        </div>
      </div>
    {/if}

    <!-- ── Questions ── -->
    <div class="space-y-3">
      {#each visibleItems as item, qi (item.id)}
        <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 shadow-sm">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="flex items-start gap-2 mb-1.5">
            <span
              class="text-[10px] font-bold text-text-muted bg-cn-border/50 rounded-md px-1.5 py-0.5 mt-0.5 shrink-0 tabular-nums"
            >
              {qi + 1}
            </span>
            <span class="text-sm font-bold text-text-main leading-snug">
              {item.label}
              {#if item.required}<span class="text-red-500 ml-0.5">*</span>{/if}
            </span>
          </label>

          {#if item.description}
            <p class="text-xs text-text-muted mb-3 ml-6 leading-relaxed">{item.description}</p>
          {/if}

          {#if item.imageUrl}
            <div class="mb-3 ml-6 rounded-xl overflow-hidden border border-cn-border/60">
              <img src={item.imageUrl} alt="" class="w-full max-h-48 object-cover" loading="lazy" />
            </div>
          {/if}

          {#if item.type === 'short_text'}
            <input
              type="text"
              class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-cn-bg outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              placeholder="Votre réponse…"
              disabled={submitted || isNotOpenYet}
            />
          {:else if item.type === 'long_text'}
            <textarea
              rows="4"
              class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-cn-bg outline-none transition-all resize-y placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              placeholder="Votre réponse…"
              disabled={submitted || isNotOpenYet}
            ></textarea>
          {:else if item.type === 'dropdown' || item.type === 'single'}
            <select
              class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-sm text-text-main bg-cn-bg outline-none transition-all appearance-none focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              disabled={submitted || isNotOpenYet}
            >
              <option value="" disabled>Choisir une option…</option>
              {#each item.options ?? [] as opt (opt.id)}
                <option value={opt.id}>
                  {opt.label}{optionModifier(opt) > 0
                    ? ` (+${formatCurrency(optionModifier(opt), form.currency)})`
                    : optionModifier(opt) < 0
                      ? ` (${formatCurrency(optionModifier(opt), form.currency)})`
                      : ''}
                </option>
              {/each}
            </select>
          {:else if item.type === 'single_choice'}
            <div class="space-y-2">
              {#each item.options ?? [] as opt (opt.id)}
                <label
                  class="flex items-center gap-3 px-4 py-3 rounded-2xl border-2 cursor-pointer select-none transition-all
                  {selections[item.id] === opt.id
                    ? 'border-cn-yellow bg-cn-yellow/8'
                    : 'border-cn-border hover:border-cn-yellow/60 bg-cn-bg'}
                  {submitted || isNotOpenYet ? 'opacity-60 cursor-not-allowed' : ''}"
                >
                  <input
                    type="radio"
                    name={`radio-${form.id}-${item.id}`}
                    value={opt.id}
                    bind:group={selections[item.id]}
                    class="h-4 w-4 accent-cn-yellow shrink-0"
                    disabled={submitted || isNotOpenYet}
                  />
                  <span class="text-sm text-text-main font-medium flex-1">{opt.label}</span>
                  {#if optionModifier(opt) !== 0}
                    <span
                      class="text-xs font-bold text-cn-dark bg-cn-yellow/20 px-2 py-0.5 rounded-full shrink-0"
                    >
                      {optionModifier(opt) > 0 ? '+' : ''}{formatCurrency(
                        optionModifier(opt),
                        form.currency
                      )}
                    </span>
                  {/if}
                </label>
              {/each}
            </div>
          {:else if item.type === 'multiple_choice'}
            <div class="space-y-2">
              {#each item.options ?? [] as opt (opt.id)}
                <label
                  class="flex items-center gap-3 px-4 py-3 rounded-2xl border-2 cursor-pointer select-none transition-all
                  {(selections[item.id] ?? []).includes(opt.id)
                    ? 'border-cn-yellow bg-cn-yellow/8'
                    : 'border-cn-border hover:border-cn-yellow/60 bg-cn-bg'}
                  {submitted || isNotOpenYet ? 'opacity-60 cursor-not-allowed' : ''}"
                >
                  <input
                    type="checkbox"
                    value={opt.id}
                    bind:group={selections[item.id]}
                    class="h-4 w-4 accent-cn-yellow shrink-0 rounded"
                    disabled={submitted || isNotOpenYet}
                  />
                  <span class="text-sm text-text-main font-medium flex-1">{opt.label}</span>
                  {#if optionModifier(opt) !== 0}
                    <span
                      class="text-xs font-bold text-cn-dark bg-cn-yellow/20 px-2 py-0.5 rounded-full shrink-0"
                    >
                      {optionModifier(opt) > 0 ? '+' : ''}{formatCurrency(
                        optionModifier(opt),
                        form.currency
                      )}
                    </span>
                  {/if}
                </label>
              {/each}
            </div>
          {:else if item.type === 'linear_scale'}
            <div>
              <div class="flex justify-between text-xs font-semibold text-text-muted mb-2 px-1">
                <span>{item.scale?.minLabel || item.scale?.min}</span>
                <span>{item.scale?.maxLabel || item.scale?.max}</span>
              </div>
              <div
                class="flex items-stretch gap-1 rounded-2xl border-2 border-cn-border overflow-hidden bg-cn-bg"
              >
                {#each Array.from({ length: (item.scale?.max || 5) - (item.scale?.min || 1) + 1 }, (_, i) => (item.scale?.min || 1) + i) as val (val)}
                  <label
                    class="flex-1 flex flex-col items-center justify-center gap-1.5 py-3 cursor-pointer transition-all select-none
                    {selections[item.id] === val ? 'bg-cn-yellow/15' : 'hover:bg-cn-border/30'}
                    {submitted || isNotOpenYet ? 'cursor-not-allowed opacity-60' : ''}"
                  >
                    <input
                      type="radio"
                      name={`scale-${form.id}-${item.id}`}
                      value={val}
                      bind:group={selections[item.id]}
                      class="h-4 w-4 accent-cn-yellow"
                      disabled={submitted || isNotOpenYet}
                    />
                    <span class="text-xs font-bold text-text-muted">{val}</span>
                  </label>
                {/each}
              </div>
            </div>
          {:else if ['matrix_single', 'matrix_multiple'].includes(item.type)}
            <div class="overflow-x-auto rounded-2xl border-2 border-cn-border">
              <table class="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr class="bg-cn-border/20">
                    <th class="w-1/3 min-w-[120px] sticky left-0 bg-[var(--cn-surface)] z-10 p-3"
                    ></th>
                    {#each item.options ?? [] as col (col.id)}
                      <th
                        class="px-3 py-3 text-center font-bold text-xs text-text-muted uppercase tracking-wide min-w-[80px]"
                        >{col.label}</th
                      >
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each item.rows ?? [] as row (row)}
                    <tr class="hover:bg-cn-border/10 transition-colors">
                      <td
                        class="py-3 px-3 font-medium text-sm text-text-main sticky left-0 bg-[var(--cn-surface)] z-10 border-t border-cn-border"
                        >{row}</td
                      >
                      {#each item.options ?? [] as col (col.id)}
                        <td class="text-center py-3 border-t border-cn-border">
                          {#if item.type === 'matrix_single'}
                            <input
                              type="radio"
                              name={`matrix-${form.id}-${item.id}-${row}`}
                              value={col.id}
                              bind:group={selections[item.id][row]}
                              class="h-4 w-4 accent-cn-yellow"
                              disabled={submitted || isNotOpenYet}
                            />
                          {:else}
                            <input
                              type="checkbox"
                              value={col.id}
                              bind:group={selections[item.id][row]}
                              class="h-4 w-4 accent-cn-yellow"
                              disabled={submitted || isNotOpenYet}
                            />
                          {/if}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="p-3 bg-red-50 text-red-600 text-xs rounded-xl border border-red-200">
              Type non supporté : <strong>{item.type}</strong>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- ── Payment method (cash vs Stripe) ── -->
    {#if calculateTotal() > 0 && form.allowCashPayment && !submitted}
      <div class="mt-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5">
        <p class="text-xs font-bold text-text-muted uppercase tracking-wide mb-3">
          Mode de paiement
        </p>
        <div class="grid grid-cols-2 gap-2">
          <label
            class="flex items-center gap-2.5 px-4 py-3 rounded-2xl border-2 cursor-pointer select-none transition-all {paymentMethodChoice ===
            'stripe'
              ? 'border-cn-yellow bg-cn-yellow/8'
              : 'border-cn-border hover:border-cn-yellow/50'}"
          >
            <input
              type="radio"
              bind:group={paymentMethodChoice}
              value="stripe"
              class="accent-cn-yellow"
            />
            <div>
              <p class="text-sm font-semibold text-text-main">En ligne</p>
              <p class="text-xs text-text-muted">Carte / wallet</p>
            </div>
          </label>
          <label
            class="flex items-center gap-2.5 px-4 py-3 rounded-2xl border-2 cursor-pointer select-none transition-all {paymentMethodChoice ===
            'cash'
              ? 'border-cn-yellow bg-cn-yellow/8'
              : 'border-cn-border hover:border-cn-yellow/50'}"
          >
            <input
              type="radio"
              bind:group={paymentMethodChoice}
              value="cash"
              class="accent-cn-yellow"
            />
            <div>
              <p class="text-sm font-semibold text-text-main">En espèces</p>
              <p class="text-xs text-text-muted">Validé par un admin</p>
            </div>
          </label>
        </div>
      </div>
    {/if}

    <!-- ── Error ── -->
    {#if error}
      <div
        class="mt-4 rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-300"
      >
        {error}
      </div>
    {/if}
  {/if}
</div>

<!-- ── Sticky bottom bar ── -->
{#if form && !loading}
  <div
    class="keyboard-aware-bottom fixed bottom-0 inset-x-0 md:left-[4.5rem] z-50 pointer-events-none pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-5"
  >
    <div class="max-w-2xl mx-auto px-4">
      <div
        class="pointer-events-auto rounded-2xl border border-cn-border/60 bg-[var(--cn-surface)]/90 backdrop-blur-xl shadow-lg px-4 py-3 flex items-center gap-3"
      >
        <div class="flex-1 min-w-0">
          {#if submitted}
            <span class="text-sm font-bold text-green-600 flex items-center gap-1.5"
              ><Check size={16} /> Réponse envoyée</span
            >
          {:else if calculateTotal() > 0}
            <div>
              <p class="text-xs text-text-muted font-medium">Total à payer</p>
              <p class="text-lg font-extrabold text-cn-dark">
                {formatCurrency(calculateTotal(), form.currency)}
              </p>
            </div>
          {:else}
            <span class="text-sm text-text-muted">{form.submitLabel || 'Envoyer'}</span>
          {/if}
        </div>
        <Button
          variant="primary"
          class="shrink-0 px-6"
          disabled={submitted || formFull || submitting || isNotOpenYet}
          loading={submitting}
          onclick={handleSubmit}
        >
          {#if paymentPending}
            <Check size={16} class="mr-1.5" />En attente
          {:else if submitted}
            <Check size={16} class="mr-1.5" />Envoyé
          {:else if formFull}
            Complet
          {:else if calculateTotal() > 0}
            <CreditCard size={16} class="mr-1.5" />Payer {formatCurrency(
              calculateTotal(),
              form.currency
            )}
          {:else}
            <Check size={16} class="mr-1.5" />{form.submitLabel || 'Envoyer'}
          {/if}
        </Button>
      </div>

      {#if paymentPending}
        <p class="pointer-events-auto text-sm text-amber-600 font-medium text-center mt-2">
          Votre soumission est enregistrée - le paiement est en cours de confirmation.
        </p>
      {:else if formFull && !submitted}
        <p class="pointer-events-auto text-sm text-text-muted font-medium text-center mt-2">
          Ce formulaire n'accepte plus de nouvelles réponses.
        </p>
      {/if}

      {#if !submitted && form.requiresPayment && paymentMethods.length === 0 && userId}
        <div class="pointer-events-auto flex justify-center mt-2">
          <button
            type="button"
            onclick={() => void handleSaveCard()}
            disabled={savingCard}
            class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-main underline underline-offset-2 disabled:opacity-50"
          >
            <CreditCard size={13} />
            {savingCard ? 'Redirection…' : 'Enregistrer une carte pour payer plus vite'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
