<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import { currentUserId } from '$lib/stores/user';
  import { ShoppingBag, Tag, ArrowLeft } from '@lucide/svelte';
  import type { UserTag } from '$lib/associations/api';

  interface PurchaseRecord {
    id: string;
    userId: string;
    source: 'form' | 'product';
    formId: string | null;
    productId: string | null;
    amountCents: number;
    paymentMethod: 'stripe' | 'cash';
    status: 'paid' | 'pending_cash' | 'cancelled' | 'expired';
    stripePaymentIntentId: string | null;
    associationId: string;
    productName: string;
    paidAt: string;
  }

  interface PurchasesResponse {
    purchases: PurchaseRecord[];
    activeTags: UserTag[];
    cercleTopups: PurchaseRecord[];
  }

  let data = $state<PurchasesResponse | null>(null);
  let loading = $state(true);
  let error = $state('');

  const isLoggedIn = $derived(!!currentUserId());

  onMount(async () => {
    if (!isLoggedIn) {
      loading = false;
      return;
    }
    try {
      const base = socialUrl();
      const res = await apiFetch(`${base}/api/forms/me/purchases`);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      data = (await res.json()) as PurchasesResponse;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger les achats';
    } finally {
      loading = false;
    }
  });

  function formatAmount(cents: number): string {
    return `${(cents / 100).toFixed(2)} €`;
  }

  function statusLabel(status: PurchaseRecord['status']): string {
    return (
      { paid: 'Payé', pending_cash: 'En attente (cash)', cancelled: 'Annulé', expired: 'Expiré' }[
        status
      ] ?? status
    );
  }

  function statusClass(status: PurchaseRecord['status']): string {
    return status === 'paid'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'pending_cash'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-cn-surface-alt text-text-muted';
  }

  function sourceLabel(source: PurchaseRecord['source']): string {
    return source === 'form' ? 'Formulaire' : 'Boutique';
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-8">
  <div class="flex items-center gap-3">
    <a
      href="/profile"
      class="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-main transition-colors"
    >
      <ArrowLeft size={16} />
      Profil
    </a>
  </div>

  <div class="flex items-center gap-3">
    <ShoppingBag class="h-7 w-7 text-cn-accent shrink-0" />
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Mes achats</h1>
      <p class="text-sm text-text-muted mt-0.5">
        Historique de vos paiements et statuts de cotisation
      </p>
    </div>
  </div>

  {#if !isLoggedIn}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 text-center">
      <p class="text-text-muted text-sm">Connectez-vous pour voir vos achats.</p>
    </div>
  {:else if loading}
    <div class="flex justify-center py-16">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-cn-border border-t-cn-accent"></div>
    </div>
  {:else if error}
    <p class="text-red-500 text-sm">{error}</p>
  {:else if data}
    <!-- Active cotisation tags -->
    {#if data.activeTags.length > 0}
      <section class="space-y-3">
        <h2 class="text-base font-bold text-text-main flex items-center gap-2">
          <Tag size={18} class="text-cn-accent" />
          Cotisations actives
        </h2>
        <ul class="space-y-2">
          {#each data.activeTags as tag (tag.id)}
            <li
              class="flex items-center gap-3 rounded-2xl border border-cn-border bg-[var(--cn-surface)] px-5 py-3"
            >
              <div class="min-w-0 flex-1">
                <p class="font-semibold text-sm text-text-main">{tag.tagName}</p>
                <p class="text-xs text-text-muted mt-0.5">
                  {#if tag.expiresAt}
                    Expire le {new Date(tag.expiresAt).toLocaleDateString('fr-FR')}
                  {:else}
                    Pas d'expiration
                  {/if}
                  {#if tag.issuingAssocId}
                    · émis par {tag.issuingAssocId.slice(0, 8)}…
                  {/if}
                </p>
              </div>
              <span
                class="shrink-0 rounded-full bg-emerald-100 text-emerald-700 px-3 py-1 text-xs font-bold"
              >
                Actif
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Purchase history -->
    <section class="space-y-3">
      <h2 class="text-base font-bold text-text-main flex items-center gap-2">
        <ShoppingBag size={18} class="text-cn-accent" />
        Historique ({data.purchases.length})
      </h2>

      {#if data.purchases.length === 0}
        <div
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-10 text-center"
        >
          <p class="text-text-muted text-sm">Aucun achat pour le moment.</p>
          <a
            href="/shop"
            class="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-cn-accent hover:underline"
          >
            Explorer la boutique
          </a>
        </div>
      {:else}
        <ul class="space-y-2">
          {#each data.purchases as purchase (purchase.id)}
            <li
              class="flex items-center gap-3 rounded-2xl border border-cn-border bg-[var(--cn-surface)] px-5 py-4"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <p class="font-semibold text-sm text-text-main">{purchase.productName}</p>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-semibold {statusClass(
                      purchase.status
                    )}"
                  >
                    {statusLabel(purchase.status)}
                  </span>
                  <span
                    class="rounded-full bg-cn-surface-alt text-text-muted px-2 py-0.5 text-xs font-semibold"
                  >
                    {sourceLabel(purchase.source)}
                  </span>
                </div>
                <p class="text-xs text-text-muted mt-1">
                  {new Date(purchase.paidAt).toLocaleDateString('fr-FR', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                  ·
                  {purchase.paymentMethod === 'cash' ? 'Espèces' : 'Carte bancaire'}
                </p>
              </div>
              <span class="shrink-0 font-bold text-sm text-text-main">
                {formatAmount(purchase.amountCents)}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
