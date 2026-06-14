<script lang="ts">
  import { onMount } from 'svelte';
  import { listAssociationForms, type Association, type AssociationForm } from '$lib/associations/api';
  import {
    listPendingCashSubmissions,
    validateCashSubmission,
    cancelCashSubmission,
    type PendingCashSubmission,
  } from '$lib/forms/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { ClipboardList, AlertTriangle } from '@lucide/svelte';

  interface Props {
    asso: Association;
    /** True once Stripe Connect can collect online payments. */
    stripePaymentsReady: boolean;
    /** Whether the caller can configure Stripe Connect (tweaks the warning copy). */
    canManageStripeConnect: boolean;
    /** Switches the parent to the Paiements tab. */
    onGoToPayments: () => void;
  }

  let { asso, stripePaymentsReady, canManageStripeConnect, onGoToPayments }: Props = $props();

  let forms = $state<AssociationForm[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  let pendingCash = $state<Record<string, PendingCashSubmission[]>>({});
  /** True when at least one association form requires online payment (basePrice > 0). */
  let hasPaidForms = $derived(forms.some((f) => f.basePrice > 0));

  onMount(loadForms);

  async function loadForms() {
    formsLoading = true;
    formsError = '';
    try {
      forms = await listAssociationForms(asso.id);
      const cashMap: Record<string, PendingCashSubmission[]> = {};
      await Promise.all(
        forms
          .filter((f) => f.allowCashPayment)
          .map(async (f) => {
            try {
              cashMap[f.id] = await listPendingCashSubmissions(f.id);
            } catch {
              cashMap[f.id] = [];
            }
          })
      );
      pendingCash = cashMap;
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      formsLoading = false;
    }
  }

  async function validateCash(formId: string, subId: string) {
    try {
      await validateCashSubmission(formId, subId);
      pendingCash = {
        ...pendingCash,
        [formId]: pendingCash[formId].filter((s) => s.id !== subId),
      };
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function cancelCash(formId: string, subId: string) {
    if (
      !(await showConfirm('Annuler ce paiement ?', {
        danger: true,
        confirmLabel: 'Annuler le paiement',
        cancelLabel: 'Non',
      }))
    )
      return;
    try {
      await cancelCashSubmission(formId, subId);
      pendingCash = {
        ...pendingCash,
        [formId]: pendingCash[formId].filter((s) => s.id !== subId),
      };
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Erreur';
    }
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
  <div>
    <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
      <ClipboardList size={20} />
      Formulaires
    </h2>
    <p class="text-sm text-text-muted mt-1">
      Formulaires liés à cette association. Validez les paiements en espèces en attente.
    </p>
  </div>

  {#if hasPaidForms && !stripePaymentsReady}
    <div
      class="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 flex items-start gap-2.5"
    >
      <AlertTriangle size={15} class="shrink-0 mt-0.5" />
      <span>
        {#if canManageStripeConnect}
          Certains formulaires sont payants mais <strong
            >Stripe Connect n'est pas encore configuré</strong
          >. Les paiements en ligne ne fonctionneront pas tant que vous n'aurez pas
          <button
            type="button"
            class="underline font-semibold hover:no-underline"
            onclick={onGoToPayments}>configuré Stripe dans l'onglet Paiements</button
          >.
        {:else}
          Certains formulaires sont payants mais <strong>Stripe Connect n'est pas configuré</strong>.
          Demandez à un responsable disposant de l'accès <em>Gérer Stripe Connect</em> de l'activer.
        {/if}
      </span>
    </div>
  {/if}

  {#if formsError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {formsError}
    </div>
  {/if}

  {#if formsLoading}
    <div class="flex justify-center py-8">
      <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
    </div>
  {:else if forms.length === 0}
    <p class="text-sm text-text-muted text-center py-8">Aucun formulaire lié à cette association.</p>
  {:else}
    <ul class="space-y-4">
      {#each forms as form (form.id)}
        <li class="rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-4 space-y-3">
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <p class="font-semibold text-sm text-text-main">{form.title}</p>
              {#if form.description}
                <p class="text-xs text-text-muted mt-0.5 line-clamp-2">{form.description}</p>
              {/if}
              <p class="text-xs text-text-muted mt-1 flex items-center gap-1.5 flex-wrap">
                {form.basePrice > 0 ? `${(form.basePrice / 100).toFixed(2)} €` : 'Gratuit'}
                {form.allowCashPayment ? ' · Espèces acceptées' : ''}
                {#if form.basePrice > 0 && !stripePaymentsReady}
                  <span
                    class="inline-flex items-center gap-1 text-amber-700 font-medium"
                    title="Stripe Connect non configuré - les paiements en ligne sont inactifs"
                  >
                    <AlertTriangle size={11} />
                    Stripe non configuré
                  </span>
                {/if}
              </p>
            </div>
            <a
              href="/forms/{form.id}"
              class="text-xs font-semibold text-cn-yellow hover:underline shrink-0"
              target="_blank"
              rel="noopener noreferrer">Voir le formulaire ↗</a
            >
          </div>

          {#if pendingCash[form.id]?.length}
            <div class="border-t border-cn-border/50 pt-3 space-y-2">
              <p class="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                <AlertTriangle size={13} />
                {pendingCash[form.id].length} paiement{pendingCash[form.id].length > 1 ? 's' : ''} en
                attente de validation
              </p>
              <ul class="space-y-2">
                {#each pendingCash[form.id] as sub (sub.id)}
                  <li
                    class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-semibold text-text-main truncate">{sub.userId}</p>
                      <p class="text-xs text-text-muted">
                        {(sub.totalPaid / 100).toFixed(2)} € · {new Date(
                          sub.createdAt
                        ).toLocaleDateString('fr-FR')}
                      </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onclick={() => validateCash(form.id, sub.id)}
                        class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                        >Valider</button
                      >
                      <button
                        type="button"
                        onclick={() => cancelCash(form.id, sub.id)}
                        class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                        >Annuler</button
                      >
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {:else if form.allowCashPayment}
            <p class="text-xs text-text-muted border-t border-cn-border/50 pt-3">
              Aucun paiement en espèces en attente.
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
