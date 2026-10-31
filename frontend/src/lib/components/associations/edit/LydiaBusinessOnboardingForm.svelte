<script lang="ts">
  import { untrack } from 'svelte';
  import {
    startLydiaOnboarding,
    disconnectLydiaConnect,
    validateLydiaOnboarding,
    getAssociationPayoutAccount,
    type Association,
    type AssociationPayoutAccount,
  } from '$lib/associations/api';
  import {
    LYDIA_ONBOARDING_REFUSAL,
    lydiaOnboardingErrorText,
    lydiaOnboardingOutcomeUnknown,
    lydiaOnboardingRefusalCode,
  } from '$lib/associations/lydiaOnboardingRefusal';
  import { Building2, ExternalLink } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { wordingFor } from '$lib/associations/kindWording';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import Input from '$lib/components/ui/Input.svelte';

  interface Props {
    asso: Association;
    /** Called once the Lydia Business has been unlinked, so the parent can clear its ready flag. */
    onDisconnected: () => void;
    /** Called once a platform admin has validated the onboarding, so the parent can mark it locally. */
    onValidated: () => void;
  }

  let { asso, onDisconnected, onValidated }: Props = $props();

  /** The sentences naming the entity: an institution is not called an association. */
  const words = $derived(wordingFor(asso.type).lydia);

  let disconnecting = $state(false);
  let validating = $state(false);

  /**
   * The payout account, read from its own MANAGE_PAYOUT_ACCOUNT route: the association row a member
   * reads no longer carries the `vendor_token`. Null until it has loaded; the onboarding form is
   * never offered before then, so a slow read cannot invite a second `business/create`.
   */
  let account = $state<AssociationPayoutAccount | null>(null);
  let accountFailed = $state(false);

  async function loadAccount() {
    accountFailed = false;
    try {
      account = await getAssociationPayoutAccount(asso.id);
    } catch (err) {
      console.error('[Lydia] Payout account read failed:', err);
      accountFailed = true;
    }
  }

  $effect(() => {
    untrack(() => void loadAccount());
  });

  /** A platform admin confirms Lydia accepted the file; nothing else marks the onboarding complete. */
  async function handleValidate() {
    if (
      !(await showConfirm(words.validateConfirm(), {
        confirmLabel: m.asso_lydia_validate_button(),
      }))
    )
      return;
    validating = true;
    try {
      await validateLydiaOnboarding(asso.id);
      if (account) account = { ...account, lydiaOnboardingComplete: true };
      onValidated();
    } catch (err) {
      console.error('[Lydia] Manual validation failed:', err);
      error = m.asso_lydia_validate_error();
    } finally {
      validating = false;
    }
  }

  async function handleDisconnect() {
    if (
      !(await showConfirm(words.disconnectConfirm(), {
        danger: true,
        confirmLabel: m.asso_lydia_disconnect_button(),
      }))
    )
      return;
    disconnecting = true;
    try {
      await disconnectLydiaConnect(asso.id);
      account = { lydiaAccountId: null, lydiaDashboardUrl: null, lydiaOnboardingComplete: false };
      onDisconnected();
    } catch (err) {
      error = m.asso_lydia_disconnect_error();
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
      account = {
        lydiaAccountId: result.accountId,
        lydiaDashboardUrl: result.url,
        lydiaOnboardingComplete: false,
      };
    } catch (err) {
      // The detail goes to the log; the screen shows a Paraglide sentence, never the server's prose.
      console.error('[Lydia] Onboarding refused:', err);
      error = lydiaOnboardingErrorText(err);
      // A Business is linked after all (another tab, another manager): show it, not the form.
      if (lydiaOnboardingRefusalCode(err) === LYDIA_ONBOARDING_REFUSAL.ALREADY_LINKED) {
        void loadAccount();
      } else if (lydiaOnboardingOutcomeUnknown(err)) {
        // No answer: the Business may exist. Re-read the account - linked after all, the screen
        // shows it and the warning goes; still unlinked, the "check before retrying" line stays.
        void recheckAfterUnknownOutcome();
      }
    } finally {
      submitting = false;
    }
  }

  /** Re-reads the payout account after an onboarding whose outcome is unknown. */
  async function recheckAfterUnknownOutcome() {
    await loadAccount();
    if (account?.lydiaAccountId) {
      console.info('[Lydia] Onboarding outcome was unknown; the Business is linked after all');
      error = '';
    } else {
      console.warn(
        '[Lydia] Onboarding outcome unknown and no Business linked: check before retrying'
      );
    }
  }

  async function openDashboard(url: string) {
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(url);
  }
</script>

<div class="border-cn-border space-y-4 rounded-2xl border bg-[var(--cn-surface)]/95 p-6 shadow-sm">
  <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
    <Building2 size={20} />
    {m.asso_lydia_title()}
  </h2>

  {#if accountFailed}
    <p class="text-red-err text-sm" role="alert">{m.asso_lydia_account_error()}</p>
    <button
      type="button"
      onclick={() => void loadAccount()}
      class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold"
    >
      {m.asso_payments_provider_retry()}
    </button>
  {:else if !account}
    <p class="text-text-muted text-sm">{m.asso_lydia_account_loading()}</p>
  {:else if account.lydiaAccountId}
    <p class="text-text-main flex flex-wrap items-center gap-2 text-sm font-semibold">
      {m.asso_lydia_created_title()}
      <span
        class="{account.lydiaOnboardingComplete
          ? 'text-green-ok bg-green-ok/20'
          : 'text-amber-warn bg-amber-warn/20'} text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
      >
        {account.lydiaOnboardingComplete
          ? m.asso_lydia_status_active()
          : m.asso_lydia_status_pending()}
      </span>
    </p>
    {#if !account.lydiaOnboardingComplete}
      <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_created_desc()}</p>
    {/if}
    <p class="text-text-muted text-xs">
      {m.asso_lydia_vendor_token_label()}: <span class="font-mono">{account.lydiaAccountId}</span>
    </p>
    <div class="flex flex-wrap items-center gap-2">
      {#if account.lydiaDashboardUrl}
        {@const dashboardUrl = account.lydiaDashboardUrl}
        <button
          type="button"
          onclick={() => void openDashboard(dashboardUrl)}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm"
        >
          <ExternalLink size={16} />
          {m.asso_lydia_open_dashboard_button()}
        </button>
      {/if}
      {#if isGlobalAdmin() && !account.lydiaOnboardingComplete}
        <button
          type="button"
          onclick={() => void handleValidate()}
          disabled={validating}
          class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {validating ? m.asso_lydia_validate_loading() : m.asso_lydia_validate_button()}
        </button>
      {/if}
      <button
        type="button"
        onclick={() => void handleDisconnect()}
        disabled={disconnecting}
        class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {disconnecting ? m.asso_lydia_disconnect_loading() : m.asso_lydia_disconnect_button()}
      </button>
    </div>
  {:else if createdDashboardUrl}
    <p class="text-text-main flex flex-wrap items-center gap-2 text-sm font-semibold">
      {m.asso_lydia_created_title()}
      <span
        class="text-amber-warn bg-amber-warn/20 text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
      >
        {m.asso_lydia_status_pending()}
      </span>
    </p>
    <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_created_desc()}</p>
    <button
      type="button"
      onclick={() => void openDashboard(createdDashboardUrl)}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm"
    >
      <ExternalLink size={16} />
      {m.asso_lydia_open_dashboard_button()}
    </button>
  {:else}
    <p class="text-text-muted text-sm leading-relaxed">{words.intro()}</p>

    <Input label={words.nameLabel()} bind:value={name} required disabled={submitting} />
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
