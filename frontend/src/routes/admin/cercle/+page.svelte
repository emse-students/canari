<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    listAssociations,
    listAssociationProductsForManage,
    createProduct,
    updateProduct,
    listWebhookFailures,
    retryWebhookDelivery,
    deleteWebhookDelivery,
    simulateCercleTopup,
    type Association,
    type AssociationProduct,
    type CercleTopupSimulation,
    type WebhookDelivery,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    Wallet,
    AlertTriangle,
    RefreshCw,
    FlaskConical,
    CheckCircle2,
    XCircle,
    Trash2,
  } from '@lucide/svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /** Beneficiary preselected on arrival: in practice a Cercle balance belongs to Le Cercle. */
  const CERCLE_SLUG = 'cercle';
  /** Amount the test button asks for. A recharge is priced by the buyer, so this is only the test's. */
  const TEST_TOPUP_CENTS = 500;

  let ready = $state(false);
  let loading = $state(true);
  let error = $state('');

  let associations = $state<Association[]>([]);
  let selectedAssoId = $state('');
  const asso = $derived(associations.find((a) => a.id === selectedAssoId) ?? null);
  /** The single `balance_topup` product. Null until it has been configured once. */
  let product = $state<AssociationProduct | null>(null);
  let webhookFailures = $state<WebhookDelivery[]>([]);

  // Configuration form. The secret is write-only: the server never returns it, so an empty field
  // means "keep the current one" rather than "erase it".
  let minEuros = $state<number | ''>('');
  let maxEuros = $state<number | ''>('');
  let webhookUrl = $state('');
  let webhookSecret = $state('');
  let saving = $state(false);
  let saved = $state(false);

  let testing = $state(false);
  let testResult = $state<CercleTopupSimulation | null>(null);
  let retryingDelivery = $state<string | null>(null);
  let deletingDelivery = $state<string | null>(null);
  /** What the last manual retry did. A retry that silently changes nothing reads as a broken button. */
  let retryOutcome = $state<{ delivered: boolean; message: string } | null>(null);

  const isConfigured = $derived(!!product?.webhookUrl && !!product?.webhookConfigured);

  onMount(() => {
    if (!isGlobalAdmin()) {
      console.error('[ADMIN][CERCLE] non-global-admin blocked client-side, redirecting');
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
    void load();
  });

  /** Loads the beneficiary list and preselects Le Cercle, which is what this page is for. */
  async function load() {
    loading = true;
    error = '';
    console.log('[ADMIN][CERCLE] loading beneficiary associations');
    try {
      associations = (await listAssociations('association')).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      selectedAssoId = associations.find((a) => a.slug === CERCLE_SLUG)?.id ?? '';
      if (selectedAssoId) await loadProduct();
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to load associations', e);
      error = e instanceof Error ? e.message : m.admin_cercle_load_assoc_error();
    } finally {
      loading = false;
    }
  }

  /** Loads the selected association's single top-up product and its failed deliveries. */
  async function loadProduct() {
    if (!asso) {
      product = null;
      webhookFailures = [];
      return;
    }
    error = '';
    testResult = null;
    saved = false;
    console.log(`[ADMIN][CERCLE] loading top-up product for association=${asso.id}`);
    try {
      const [products, failures] = await Promise.all([
        listAssociationProductsForManage(asso.id),
        listWebhookFailures(asso.id),
      ]);
      product = products.find((p) => p.type === 'balance_topup') ?? null;
      webhookFailures = failures;
      syncFormFromProduct();
      console.log(
        `[ADMIN][CERCLE] loaded: product=${product?.id ?? 'none'} failures=${failures.length}`
      );
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to load the top-up product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_load_error();
    }
  }

  function syncFormFromProduct() {
    minEuros = product?.customAmountMinCents != null ? product.customAmountMinCents / 100 : '';
    maxEuros = product?.customAmountMaxCents != null ? product.customAmountMaxCents / 100 : '';
    webhookUrl = product?.webhookUrl ?? '';
    webhookSecret = '';
  }

  /**
   * Creates or updates THE top-up product. The shape is fixed by what a recharge is: the buyer
   * chooses the amount (`allowCustomAmount`, no fixed price), and the server forces it repeatable
   * and uncapped - so this form only ever asks for the bounds and the webhook.
   */
  async function handleSave() {
    if (!asso) return;
    saving = true;
    saved = false;
    error = '';
    const payload = {
      allowCustomAmount: true,
      customAmountMinCents: minEuros !== '' ? Math.round(Number(minEuros) * 100) : null,
      customAmountMaxCents: maxEuros !== '' ? Math.round(Number(maxEuros) * 100) : null,
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
    };
    try {
      if (product) {
        console.log(`[ADMIN][CERCLE] updating top-up product=${product.id}`);
        product = await updateProduct(asso.id, product.id, { ...payload, amountCents: null });
      } else {
        console.log('[ADMIN][CERCLE] creating the top-up product');
        product = await createProduct(asso.id, {
          name: m.admin_cercle_product_name(),
          type: 'balance_topup',
          ...payload,
          customAmountMinCents: payload.customAmountMinCents ?? undefined,
          customAmountMaxCents: payload.customAmountMaxCents ?? undefined,
        });
      }
      syncFormFromProduct();
      saved = true;
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to save the top-up product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      saving = false;
    }
  }

  async function handleToggleActive() {
    if (!asso || !product) return;
    error = '';
    try {
      console.log(`[ADMIN][CERCLE] toggling active -> ${!product.isActive}`);
      product = await updateProduct(asso.id, product.id, { isActive: !product.isActive });
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to toggle the product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    }
  }

  /**
   * Runs the production top-up path for the current admin with no Stripe charge: same purchase
   * checks, same signed webhook to the Cercle, same audit and accounting rows.
   */
  async function handleTestTopup() {
    if (!asso || !product) return;
    if (
      !(await showConfirm(
        m.admin_cercle_test_confirm({ amount: (TEST_TOPUP_CENTS / 100).toFixed(2) }),
        { confirmLabel: m.admin_cercle_test_confirm_label() }
      ))
    )
      return;
    console.log(`[ADMIN][CERCLE] running test top-up on product=${product.id}`);
    testing = true;
    testResult = null;
    error = '';
    try {
      testResult = await simulateCercleTopup(asso.id, product.id, TEST_TOPUP_CENTS);
      console.log(
        `[ADMIN][CERCLE] test top-up finished: status=${testResult.status} intent=${testResult.paymentIntentId}`
      );
      webhookFailures = await listWebhookFailures(asso.id);
    } catch (e) {
      console.error('[ADMIN][CERCLE] test top-up failed', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      testing = false;
    }
  }

  /** A member's name, falling back to the raw id when the account is gone. */
  function memberLabel(delivery: WebhookDelivery): string {
    const name = [delivery.firstName, delivery.lastName].filter(Boolean).join(' ');

    return name || m.admin_cercle_webhook_unknown_member({ id: delivery.userId.slice(0, 8) });
  }

  function formatMoment(iso: string): string {
    return new Date(iso).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  }

  /**
   * Retries one delivery and says what happened.
   *
   * The retry updates the row in place now, so a success removes it from the list - which is what
   * makes this button visibly do something. It used to insert a second row and leave this one
   * behind, so the list never changed however many times it was pressed.
   */
  async function handleRetryDelivery(delivery: WebhookDelivery) {
    if (!asso) return;
    retryingDelivery = delivery.id;
    error = '';
    retryOutcome = null;
    try {
      console.log(`[ADMIN][CERCLE] retrying delivery=${delivery.id}`);
      const updated = await retryWebhookDelivery(asso.id, delivery.id);
      retryOutcome =
        updated.status === 'delivered'
          ? { delivered: true, message: m.admin_cercle_webhook_retry_delivered() }
          : {
              delivered: false,
              message: updated.lastError ?? m.admin_cercle_webhook_retry_failed(),
            };
      webhookFailures = await listWebhookFailures(asso.id);
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to retry webhook delivery', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      retryingDelivery = null;
    }
  }

  /** Drops a failed delivery - for a top-up already settled by hand on the Cercle side. */
  async function handleDeleteDelivery(delivery: WebhookDelivery) {
    if (!asso) return;
    if (
      !(await showConfirm(
        m.admin_cercle_delivery_delete_confirm({
          amount: (delivery.amountCents / 100).toFixed(2),
        }),
        { danger: true, confirmLabel: m.common_delete_button() }
      ))
    )
      return;
    deletingDelivery = delivery.id;
    error = '';
    try {
      console.log(`[ADMIN][CERCLE] deleting failed delivery=${delivery.id}`);
      await deleteWebhookDelivery(asso.id, delivery.id);
      webhookFailures = webhookFailures.filter((d) => d.id !== delivery.id);
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to delete webhook delivery', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      deletingDelivery = null;
    }
  }
</script>

{#if ready}
  <div class="space-y-6">
    <header class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
      >
        <Wallet size={20} />
      </span>
      <div>
        <h2 class="text-lg font-extrabold text-text-main">{m.admin_cercle_title()}</h2>
        <p class="text-sm text-text-muted mt-0.5">{m.admin_cercle_subtitle()}</p>
      </div>
    </header>

    {#if error}
      <div class="rounded-xl border border-red-err/30 bg-red-err/10 text-red-err px-4 py-3 text-sm">
        {error}
      </div>
    {/if}

    {#if loading}
      <div class="flex justify-center py-10">
        <div
          class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
        ></div>
      </div>
    {:else}
      <div class="space-y-1.5">
        <label for="cercle-asso-select" class="text-sm font-bold text-text-main">
          {m.admin_cercle_asso_label()}
        </label>
        <select
          id="cercle-asso-select"
          bind:value={selectedAssoId}
          onchange={() => void loadProduct()}
          class="w-full max-w-md rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        >
          <option value="">{m.admin_cercle_asso_placeholder()}</option>
          {#each associations as assoc (assoc.id)}
            <option value={assoc.id}>{assoc.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if !loading && !asso}
      <p class="text-sm text-text-muted">{m.admin_cercle_select_asso_hint()}</p>
    {:else if !loading && asso}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm"
      >
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-base font-bold text-text-main">{m.admin_cercle_config_title()}</h3>
            <p class="text-xs text-text-muted mt-0.5">
              {m.admin_cercle_config_hint({ name: asso.name })}
            </p>
          </div>
          {#if product}
            <div class="flex items-center gap-2">
              <span
                class="rounded-full px-2.5 py-1 text-xs font-semibold {product.isActive
                  ? 'bg-green-ok/15 text-green-ok'
                  : 'bg-cn-surface-alt text-text-muted'}"
              >
                {product.isActive
                  ? m.admin_cercle_product_active()
                  : m.admin_cercle_product_inactive()}
              </span>
              <button
                type="button"
                onclick={() => void handleToggleActive()}
                class="text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-cn-bg/50 transition-colors"
              >
                {product.isActive
                  ? m.admin_cercle_deactivate_button()
                  : m.admin_cercle_activate_button()}
              </button>
            </div>
          {/if}
        </div>

        <form
          class="space-y-4"
          onsubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1">
              <label for="cercle-min" class="text-xs font-semibold text-text-muted"
                >{m.admin_cercle_min_label()}</label
              >
              <input
                id="cercle-min"
                type="number"
                min="0.01"
                step="0.01"
                bind:value={minEuros}
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div class="space-y-1">
              <label for="cercle-max" class="text-xs font-semibold text-text-muted"
                >{m.admin_cercle_max_label()}</label
              >
              <input
                id="cercle-max"
                type="number"
                min="0.01"
                step="0.01"
                bind:value={maxEuros}
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p class="text-xs text-text-muted">{m.admin_cercle_amount_hint()}</p>
          <!-- A 5 EUR recharge credits the member 5 EUR but pays the association less: the Cercle's
               treasury has to know the gap before setting the bounds. -->
          <StripeNetPayoutHint grossEuros="" {minEuros} {maxEuros} />

          <div class="space-y-1">
            <label for="cercle-webhook-url" class="text-xs font-semibold text-text-muted"
              >{m.admin_cercle_webhook_url_label()}</label
            >
            <input
              id="cercle-webhook-url"
              type="url"
              bind:value={webhookUrl}
              placeholder={m.admin_cercle_webhook_url_placeholder()}
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>

          <div class="space-y-1">
            <label for="cercle-webhook-secret" class="text-xs font-semibold text-text-muted"
              >{m.admin_cercle_webhook_secret_label()}</label
            >
            <input
              id="cercle-webhook-secret"
              type="password"
              autocomplete="off"
              bind:value={webhookSecret}
              placeholder={product?.webhookConfigured
                ? m.admin_cercle_webhook_edit_hint()
                : m.admin_cercle_webhook_secret_placeholder()}
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
            <p class="text-xs text-text-muted">
              {product?.webhookConfigured
                ? m.admin_cercle_webhook_secret_set()
                : m.admin_cercle_webhook_secret_hint()}
            </p>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
            >
              {saving
                ? m.admin_cercle_saving()
                : product
                  ? m.common_save_button()
                  : m.admin_cercle_create_button()}
            </button>
            {#if saved}
              <span class="text-xs font-semibold text-green-ok inline-flex items-center gap-1.5">
                <CheckCircle2 size={14} />
                {m.admin_cercle_saved()}
              </span>
            {/if}
          </div>
        </form>
      </div>

      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
      >
        <div>
          <h3 class="text-base font-bold text-text-main">{m.admin_cercle_test_title()}</h3>
          <p class="text-xs text-text-muted mt-0.5">
            {m.admin_cercle_test_section_hint({ amount: (TEST_TOPUP_CENTS / 100).toFixed(2) })}
          </p>
        </div>

        <button
          type="button"
          disabled={testing || !isConfigured}
          onclick={() => void handleTestTopup()}
          class="inline-flex items-center gap-2 rounded-xl border border-cn-yellow/50 bg-cn-yellow/10 px-4 py-2.5 text-sm font-bold text-text-main hover:bg-cn-yellow/20 disabled:opacity-50 transition-colors"
        >
          <FlaskConical size={16} class={testing ? 'animate-pulse' : ''} />
          {testing
            ? m.admin_cercle_test_running()
            : m.admin_cercle_test_button({ amount: (TEST_TOPUP_CENTS / 100).toFixed(2) })}
        </button>
        {#if !isConfigured}
          <p class="text-xs text-amber-warn">{m.admin_cercle_test_needs_config()}</p>
        {/if}

        {#if testResult}
          {@const delivered = testResult.status === 'delivered'}
          <div
            class="rounded-xl border px-4 py-3 space-y-1 {delivered
              ? 'border-green-ok/30 bg-green-ok/10'
              : 'border-red-err/30 bg-red-err/10'}"
          >
            <p
              class="flex items-center gap-2 text-sm font-bold {delivered
                ? 'text-green-ok'
                : 'text-red-err'}"
            >
              {#if delivered}
                <CheckCircle2 size={16} />
                {m.admin_cercle_test_delivered({
                  amount: (testResult.amountCents / 100).toFixed(2),
                  attempts: testResult.attemptCount,
                })}
              {:else}
                <XCircle size={16} />
                {m.admin_cercle_test_failed({ attempts: testResult.attemptCount })}
              {/if}
            </p>
            {#if testResult.lastError}
              <p class="text-xs text-red-err break-all">{testResult.lastError}</p>
            {/if}
            <p class="text-xs text-text-muted break-all">
              {m.admin_cercle_test_intent({ intent: testResult.paymentIntentId })}
            </p>
          </div>
        {/if}
      </div>

      {#if webhookFailures.length > 0}
        <div
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-3 shadow-sm"
        >
          <h3 class="text-sm font-bold flex items-center gap-2 text-amber-warn">
            <AlertTriangle size={16} />
            {m.admin_cercle_webhook_failures_title({ count: webhookFailures.length })}
          </h3>
          <p class="text-xs text-text-muted">{m.admin_cercle_webhook_failures_hint()}</p>

          {#if retryOutcome}
            <p
              class="rounded-xl border px-3 py-2 text-xs font-semibold {retryOutcome.delivered
                ? 'border-green-ok/30 bg-green-ok/10 text-green-ok'
                : 'border-red-err/30 bg-red-err/10 text-red-err'}"
            >
              {retryOutcome.message}
            </p>
          {/if}

          <ul class="space-y-2">
            {#each webhookFailures as delivery (delivery.id)}
              <li
                class="flex items-center gap-3 rounded-xl border border-amber-warn/30 bg-amber-warn/10 px-4 py-3"
              >
                <div class="min-w-0 flex-1 space-y-0.5">
                  <p class="text-xs font-semibold text-text-main">
                    {memberLabel(delivery)} - {(delivery.amountCents / 100).toFixed(2)} €
                    {#if delivery.productName}
                      <span class="font-normal text-text-muted">· {delivery.productName}</span>
                    {/if}
                  </p>
                  <p class="text-xs text-text-muted">
                    {m.admin_cercle_webhook_attempts({ count: delivery.attemptCount })} ·
                    {delivery.lastAttemptAt ? formatMoment(delivery.lastAttemptAt) : '-'}
                  </p>
                  <!--
                    What happens NEXT without anyone doing anything: a row on the automatic ladder
                    needs no decision, an exhausted one is the only kind that does.
                  -->
                  <p
                    class="text-xs {delivery.nextAttemptAt ? 'text-text-muted' : 'text-amber-warn'}"
                  >
                    {delivery.nextAttemptAt
                      ? m.admin_cercle_webhook_next_attempt({
                          moment: formatMoment(delivery.nextAttemptAt),
                        })
                      : m.admin_cercle_webhook_retries_exhausted()}
                  </p>
                  {#if delivery.lastError}
                    <p class="text-xs text-red-err break-all">{delivery.lastError}</p>
                  {/if}
                  <p class="text-xs text-text-muted break-all">{delivery.paymentIntentId}</p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={retryingDelivery === delivery.id}
                    onclick={() => void handleRetryDelivery(delivery)}
                    class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-1.5 text-xs font-semibold hover:bg-[var(--cn-surface)] disabled:opacity-50"
                  >
                    <RefreshCw
                      size={13}
                      class={retryingDelivery === delivery.id ? 'animate-spin' : ''}
                    />
                    {m.common_retry_button()}
                  </button>
                  <button
                    type="button"
                    disabled={deletingDelivery === delivery.id}
                    onclick={() => void handleDeleteDelivery(delivery)}
                    title={m.common_delete_button()}
                    class="inline-flex items-center justify-center rounded-xl border border-red-err/30 bg-red-err/10 p-2 text-red-err hover:bg-red-err/20 disabled:opacity-50 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </div>
{/if}
