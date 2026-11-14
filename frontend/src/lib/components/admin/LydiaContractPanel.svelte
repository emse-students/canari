<script lang="ts">
  import { onMount } from 'svelte';
  import { Handshake, Save, Plus, Trash2, RefreshCw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { intlLocale } from '$lib/utils/intlLocale';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import {
    LYDIA_PAYMENT_KINDS,
    LydiaContractFormInvalid,
    LydiaContractRefused,
    emptyLydiaBand,
    fetchLydiaContract,
    fetchLydiaContractCounter,
    fluxSharePercent,
    fromLydiaContractForm,
    saveLydiaContract,
    toLydiaContractForm,
    type LydiaContractCounter,
    type LydiaContractForm,
    type LydiaPaymentKind,
  } from '$lib/admin/lydiaContract';

  /**
   * The platform's Lydia contract on the admin page: its terms, entered here and nowhere else, and
   * the counter of the contract year's flux against the target (docs/wiki/lydia-contract-flux.md).
   * A value not entered is shown "not configured", never a default.
   */

  let form = $state<LydiaContractForm | null>(null);
  let loadError = $state(false);
  let saving = $state(false);
  let saveError = $state('');
  let saved = $state(false);
  let counter = $state<LydiaContractCounter | null>(null);
  let counterError = $state(false);

  const KIND_LABELS: Record<LydiaPaymentKind, () => string> = {
    remote: m.admin_lydia_kind_remote,
    qr: m.admin_lydia_kind_qr,
    tap_to_pay: m.admin_lydia_kind_tap_to_pay,
  };

  const FIELD_LABELS = {
    anniversary: m.admin_lydia_field_anniversary,
    target: m.admin_lydia_field_target,
    bands: m.admin_lydia_field_bands,
  } as const;

  async function load() {
    Log.d('[admin.lydia] loading the contract');
    loadError = false;
    try {
      form = toLydiaContractForm(await fetchLydiaContract());
    } catch (e) {
      Log.w('[admin.lydia] the contract could not be loaded', e);
      loadError = true;
    }
    await loadCounter();
  }

  async function loadCounter() {
    counterError = false;
    try {
      counter = await fetchLydiaContractCounter();
    } catch (e) {
      Log.w('[admin.lydia] the counter could not be read', e);
      counter = null;
      counterError = true;
    }
  }

  async function save() {
    if (!form) return;
    saving = true;
    saveError = '';
    saved = false;
    try {
      form = toLydiaContractForm(await saveLydiaContract(fromLydiaContractForm(form)));
      saved = true;
      await loadCounter();
    } catch (e) {
      if (e instanceof LydiaContractFormInvalid || e instanceof LydiaContractRefused) {
        saveError = m.admin_lydia_invalid({ field: e.field ?? '-' });
      } else {
        Log.w('[admin.lydia] the contract could not be saved', e);
        saveError = m.admin_lydia_save_failed();
      }
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void load();
  });

  const eur = (cents: number) => formatAmount(cents, 'eur');
  const percentFormat = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 });
  /** "12,3" - the share of the total, or null when the total is not positive. */
  function sharePercent(cents: number): string | null {
    const p = counter?.flux ? fluxSharePercent(cents, counter.flux.fluxCents) : null;
    return p === null ? null : percentFormat.format(p);
  }
  const progress = $derived(
    counter?.flux && counter.targetCents
      ? Math.max(0, Math.min(100, (counter.flux.fluxCents / counter.targetCents) * 100))
      : 0
  );
</script>

<section class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-5">
  <header class="flex items-start gap-3">
    <span
      class="bg-accent/15 text-cn-dark flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
    >
      <Handshake size={18} />
    </span>
    <div>
      <h3 class="text-text-main text-sm font-bold">{m.admin_lydia_section_title()}</h3>
      <p class="text-text-muted mt-0.5 text-xs">{m.admin_lydia_section_desc()}</p>
    </div>
  </header>

  <div class="space-y-2" aria-live="polite">
    <h4 class="text-text-main text-sm font-bold">{m.admin_lydia_counter_title()}</h4>
    {#if counterError}
      <p class="text-sm text-red-500" role="alert">{m.admin_lydia_counter_failed()}</p>
    {:else if counter}
      {#if counter.missing.length > 0}
        <p class="text-amber-warn-text text-xs" role="status">
          {m.admin_lydia_counter_not_configured({
            fields: counter.missing.map((f) => FIELD_LABELS[f]()).join(', '),
          })}
        </p>
      {/if}
      {#if counter.year && counter.flux}
        <p class="text-text-muted text-xs">
          {m.admin_lydia_counter_year({
            start: counter.year.start,
            end: counter.year.end,
            days: counter.year.daysLeft,
          })}
        </p>
        <p class="text-text-main text-sm font-bold">
          {counter.targetCents === null
            ? eur(counter.flux.fluxCents)
            : m.admin_lydia_counter_flux({
                flux: eur(counter.flux.fluxCents),
                target: eur(counter.targetCents),
              })}
        </p>
        {#if counter.targetCents !== null}
          <div
            class="bg-cn-border h-2 w-full overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(progress)}
          >
            <div class="bg-accent h-full rounded-full" style:width="{progress}%"></div>
          </div>
        {/if}
        <p class="text-text-muted text-xs">
          {m.admin_lydia_counter_detail({
            paid: eur(counter.flux.paidCents),
            payments: counter.flux.paymentCount,
            refunded: eur(counter.flux.refundedCents),
            refunds: counter.flux.refundCount,
          })}
        </p>
        {#if counter.flux.excludedCount > 0}
          <p class="text-text-muted text-xs">
            {m.admin_lydia_counter_excluded({
              amount: eur(counter.flux.excludedCents),
              count: counter.flux.excludedCount,
            })}
          </p>
        {/if}
        {#if counter.flux.untraceableCount > 0}
          <p class="text-sm text-red-500" role="alert">
            {m.admin_lydia_counter_untraceable({ count: counter.flux.untraceableCount })}
          </p>
        {/if}
        {#if counter.missing.indexOf('bands') === -1}
          <p class="text-text-main text-xs">
            {counter.band
              ? m.admin_lydia_counter_band({ from: eur(counter.band.fromCents) })
              : m.admin_lydia_counter_band_none()}
            {#if counter.nextBand}
              {m.admin_lydia_counter_next_band({
                from: eur(counter.nextBand.fromCents),
                missing: eur(counter.nextBand.fromCents - counter.flux.fluxCents),
              })}
            {/if}
          </p>
        {/if}
        {#if counter.flux.byAssociation.length > 0}
          <div class="space-y-2" data-testid="lydia-flux-breakdown">
            <h5 class="text-text-main text-xs font-bold">{m.admin_lydia_breakdown_title()}</h5>
            <ul class="space-y-2">
              {#each counter.flux.byAssociation as share (share.associationId)}
                {@const percent = sharePercent(share.fluxCents)}
                <li class="border-cn-border rounded-lg border px-3 py-2 text-xs">
                  <p class="text-text-main font-semibold">
                    {share.name ?? m.admin_lydia_breakdown_deleted()}
                    {#if share.type === 'list'}
                      <span class="text-text-muted font-normal"
                        >({m.admin_lydia_breakdown_list()})</span
                      >
                    {/if}
                  </p>
                  <p class="text-text-main">
                    {percent === null
                      ? eur(share.fluxCents)
                      : m.admin_lydia_breakdown_flux({
                          flux: eur(share.fluxCents),
                          share: percent,
                        })}
                  </p>
                  <p class="text-text-muted">
                    {m.admin_lydia_breakdown_detail({
                      paid: eur(share.paidCents),
                      refunded: eur(share.refundedCents),
                    })}
                  </p>
                  {#if share.excludedCount > 0}
                    <p class="text-text-muted">
                      {m.admin_lydia_breakdown_excluded({ amount: eur(share.excludedCents) })}
                    </p>
                  {/if}
                  {#if share.untraceableCount > 0}
                    <p class="text-red-500">
                      {m.admin_lydia_breakdown_untraceable({ amount: eur(share.untraceableCents) })}
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <p class="text-text-muted text-xs">{m.admin_lydia_counter_in_person_note()}</p>
      {:else if counter.missing.indexOf('anniversary') === -1}
        <p class="text-text-muted text-xs">{m.admin_lydia_counter_not_started()}</p>
      {/if}
    {/if}
  </div>

  {#if loadError}
    <p class="text-sm text-red-500" role="alert">{m.admin_lydia_load_failed()}</p>
  {:else if form}
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="grid gap-4 sm:grid-cols-3">
        <Input
          id="lydia-anniversary"
          type="date"
          label={m.admin_lydia_anniversary_label()}
          bind:value={form.anniversary}
        />
        <Input
          id="lydia-target"
          inputmode="decimal"
          label={m.admin_lydia_target_label()}
          bind:value={form.target}
        />
        <Input
          id="lydia-vat"
          inputmode="decimal"
          label={m.admin_lydia_vat_label()}
          bind:value={form.vat}
        />
      </div>

      <fieldset class="space-y-2">
        <legend class="text-text-main text-sm font-bold">{m.admin_lydia_fees_title()}</legend>
        {#each LYDIA_PAYMENT_KINDS as kind (kind)}
          <div class="grid items-end gap-2 sm:grid-cols-3">
            <p class="text-text-main text-sm">{KIND_LABELS[kind]()}</p>
            <Input
              inputmode="decimal"
              label={m.admin_lydia_percent_label()}
              bind:value={form.fees[kind].percent}
            />
            <Input
              inputmode="decimal"
              label={m.admin_lydia_fixed_label()}
              bind:value={form.fees[kind].fixed}
            />
          </div>
        {/each}
      </fieldset>

      <fieldset class="space-y-3">
        <legend class="text-text-main text-sm font-bold">{m.admin_lydia_bands_title()}</legend>
        {#each form.bands as band, i (i)}
          <div class="border-cn-border space-y-2 rounded-xl border p-3">
            <div class="flex items-end gap-2">
              <Input
                class="flex-1"
                inputmode="decimal"
                label={m.admin_lydia_band_from_label()}
                bind:value={band.from}
              />
              <Button
                variant="danger-outline"
                onclick={() => form && (form.bands = form.bands.filter((_, j) => j !== i))}
              >
                <Trash2 size={16} />
                {m.admin_lydia_band_remove()}
              </Button>
            </div>
            {#each LYDIA_PAYMENT_KINDS as kind (kind)}
              <div class="grid items-end gap-2 sm:grid-cols-3">
                <p class="text-text-main text-xs">{KIND_LABELS[kind]()}</p>
                <Input
                  inputmode="decimal"
                  label={m.admin_lydia_percent_label()}
                  bind:value={band.fees[kind].percent}
                />
                <Input
                  inputmode="decimal"
                  label={m.admin_lydia_fixed_label()}
                  bind:value={band.fees[kind].fixed}
                />
              </div>
            {/each}
          </div>
        {/each}
        <Button
          variant="secondary"
          onclick={() => form && (form.bands = [...form.bands, emptyLydiaBand()])}
        >
          <Plus size={16} />
          {m.admin_lydia_band_add()}
        </Button>
      </fieldset>

      {#if saveError}
        <p class="text-sm text-red-500" role="alert">{saveError}</p>
      {/if}
      {#if saved}
        <p class="text-green-ok text-sm" role="status">{m.admin_lydia_saved()}</p>
      {/if}

      <div class="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>
          <Save size={16} />
          {saving ? m.common_saving_label() : m.admin_lydia_save()}
        </Button>
        <Button variant="secondary" disabled={saving} onclick={() => void load()}>
          <RefreshCw size={16} />
          {m.common_reload_button()}
        </Button>
      </div>
    </form>
  {/if}
</section>
