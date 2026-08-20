<script lang="ts">
  import { untrack } from 'svelte';
  import {
    startLydiaOnboarding,
    disconnectLydiaConnect,
    type Association,
  } from '$lib/associations/api';
  import { Building2, ExternalLink } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Input from '$lib/components/ui/Input.svelte';

  interface Props {
    asso: Association;
    /** Called with the vendor token Lydia returned, so the parent can persist it locally. */
    onAccountCreated: (accountId: string) => void;
    /** Called once the Lydia Business has been unlinked, so the parent can clear it locally. */
    onDisconnected: () => void;
  }

  let { asso, onAccountCreated, onDisconnected }: Props = $props();

  let disconnecting = $state(false);

  async function handleDisconnect() {
    if (
      !(await showConfirm(m.asso_lydia_disconnect_confirm(), {
        danger: true,
        confirmLabel: m.asso_lydia_disconnect_button(),
      }))
    )
      return;
    disconnecting = true;
    try {
      await disconnectLydiaConnect(asso.id);
      onDisconnected();
    } catch (err) {
      error = err instanceof Error ? err.message : m.asso_lydia_disconnect_error();
    } finally {
      disconnecting = false;
    }
  }

  // Editable copies seeded once from the association passed at mount.
  const initial = untrack(() => asso);
  let name = $state(initial.name);
  let address = $state('');
  let zipcode = $state('');
  let city = $state('');
  let country = $state('France');
  let businessEmail = $state(initial.contactEmail ?? '');
  let businessPhone = $state('');

  let submitting = $state(false);
  let error = $state('');
  let createdDashboardUrl = $state('');

  const missingFields = $derived(
    !name.trim() ||
      !address.trim() ||
      !zipcode.trim() ||
      !city.trim() ||
      !country.trim() ||
      !businessEmail.trim() ||
      !businessPhone.trim()
  );

  async function handleSubmit() {
    if (missingFields) return;
    submitting = true;
    error = '';
    try {
      const result = await startLydiaOnboarding(asso.id, {
        name: name.trim(),
        address: address.trim(),
        zipcode: zipcode.trim(),
        city: city.trim(),
        country: country.trim(),
        businessEmail: businessEmail.trim(),
        businessPhone: businessPhone.trim(),
      });
      createdDashboardUrl = result.url;
      onAccountCreated(result.accountId);
    } catch (err) {
      error = err instanceof Error ? err.message : m.common_save_error();
    } finally {
      submitting = false;
    }
  }

  async function openDashboard() {
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(createdDashboardUrl);
  }
</script>

<div class="border-cn-border space-y-4 rounded-2xl border bg-[var(--cn-surface)]/95 p-6 shadow-sm">
  <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
    <Building2 size={20} />
    {m.asso_lydia_title()}
  </h2>

  {#if asso.lydiaAccountId}
    <p class="text-green-ok text-sm font-semibold">{m.asso_lydia_created_title()}</p>
    <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_created_desc()}</p>
    <p class="text-text-muted text-xs">
      {m.asso_lydia_vendor_token_label()}: <span class="font-mono">{asso.lydiaAccountId}</span>
    </p>
    <button
      type="button"
      onclick={() => void handleDisconnect()}
      disabled={disconnecting}
      class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
    >
      {disconnecting ? m.asso_lydia_disconnect_loading() : m.asso_lydia_disconnect_button()}
    </button>
  {:else if createdDashboardUrl}
    <p class="text-green-ok text-sm font-semibold">{m.asso_lydia_created_title()}</p>
    <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_created_desc()}</p>
    <button
      type="button"
      onclick={() => void openDashboard()}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm"
    >
      <ExternalLink size={16} />
      {m.asso_lydia_open_dashboard_button()}
    </button>
  {:else}
    <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_intro()}</p>

    <Input label={m.asso_lydia_name_label()} bind:value={name} required disabled={submitting} />
    <Input
      label={m.asso_lydia_address_label()}
      bind:value={address}
      required
      disabled={submitting}
    />
    <div class="grid grid-cols-2 gap-3">
      <Input
        label={m.asso_lydia_zipcode_label()}
        bind:value={zipcode}
        required
        disabled={submitting}
      />
      <Input label={m.asso_lydia_city_label()} bind:value={city} required disabled={submitting} />
    </div>
    <Input
      label={m.asso_lydia_country_label()}
      bind:value={country}
      required
      disabled={submitting}
    />
    <Input
      label={m.asso_lydia_business_email_label()}
      type="email"
      bind:value={businessEmail}
      required
      disabled={submitting}
    />
    <Input
      label={m.asso_lydia_business_phone_label()}
      type="tel"
      bind:value={businessPhone}
      placeholder="+33600000000"
      required
      disabled={submitting}
    />

    <button
      type="button"
      onclick={() => void handleSubmit()}
      disabled={submitting || missingFields}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
    >
      {submitting ? m.asso_lydia_submitting_label() : m.asso_lydia_submit_button()}
    </button>
  {/if}

  {#if error}
    <div class="text-red-err text-sm">{error}</div>
  {/if}
</div>
