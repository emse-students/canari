<script lang="ts">
  import { untrack } from 'svelte';
  import {
    startLydiaOnboarding,
    disconnectLydiaConnect,
    validateLydiaOnboarding,
    clearLydiaEnrolmentInFlight,
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
  import {
    lydiaEnrolmentView,
    type LydiaEnrolmentStep,
  } from '$lib/associations/lydiaEnrolmentSteps';
  import { Building2, Check } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { wordingFor } from '$lib/associations/kindWording';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import Input from '$lib/components/ui/Input.svelte';
  import LydiaResponsableForm from './LydiaResponsableForm.svelte';

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
  let clearing = $state(false);
  let resending = $state(false);
  let resent = $state(false);

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
      onValidated();
      await loadAccount();
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
      onDisconnected();
      await loadAccount();
    } catch (err) {
      console.error('[Lydia] Disconnect failed:', err);
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
      await startLydiaOnboarding(asso.id, {
        name: name.trim(),
        address: address.trim(),
        zipcode: zipcode.trim(),
        city: city.trim(),
        country: country.trim(),
        businessEmail: businessEmail.trim(),
        businessPhone: businessPhone.trim(),
      });
      // The screen comes from the server read, never from a patched local copy.
      await loadAccount();
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

  /** A platform admin checked with Lydia: the in-flight marker no longer blocks a new enrolment. */
  async function handleClearInFlight() {
    clearing = true;
    try {
      await clearLydiaEnrolmentInFlight(asso.id);
      error = '';
      await loadAccount();
    } catch (err) {
      console.error('[Lydia] Clearing the in-flight marker failed:', err);
      error = m.asso_lydia_in_flight_clear_error();
    } finally {
      clearing = false;
    }
  }

  /** Re-reads the account after a Responsable was added or recorded, then shows the confirmation. */
  async function onResponsableDone(resend: boolean) {
    resent = resend;
    resending = false;
    await loadAccount();
  }

  const view = $derived(account ? lydiaEnrolmentView(account, isGlobalAdmin()) : null);

  /** The step's title. */
  function stepTitle(step: LydiaEnrolmentStep): string {
    switch (step.id) {
      case 'details':
        return m.asso_lydia_step_details_title();
      case 'responsable':
        return m.asso_lydia_step_responsable_title();
      case 'activate':
        return m.asso_lydia_step_activate_title();
      case 'validation':
        return m.asso_lydia_step_validation_title();
    }
  }

  /** The step's state spoken to a screen reader (the badge is visual only). */
  function stepStateLabel(step: LydiaEnrolmentStep): string {
    switch (step.state) {
      case 'done':
        return m.asso_lydia_step_state_done();
      case 'current':
        return m.asso_lydia_step_state_current();
      case 'upcoming':
        return m.asso_lydia_step_state_upcoming();
      case 'in-flight':
        return m.asso_lydia_step_state_in_flight();
      case 'paused':
        return m.asso_lydia_step_state_paused();
    }
  }

  /** The pause date in the reader's locale. */
  function formatPauseDate(iso: string): string {
    return new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  }
</script>

<div class="border-cn-border space-y-4 rounded-2xl border bg-[var(--cn-surface)]/95 p-6 shadow-sm">
  <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
    <Building2 size={20} />
    {m.asso_lydia_title()}
  </h2>

  {#snippet adminAndDisconnect(canValidate: boolean)}
    <div class="flex flex-wrap items-center gap-2">
      {#if canValidate}
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
  {/snippet}

  {#snippet resendControl(responsable: { userId: string; name: string; phoneEnd: string })}
    <div class="space-y-2">
      {#if resending}
        <p class="text-text-muted text-xs">{m.asso_lydia_resp_resend_hint()}</p>
        <LydiaResponsableForm
          associationId={asso.id}
          mode="add"
          fixedUserId={responsable.userId}
          submitLabel={m.asso_lydia_resp_resend_button()}
          onDone={() => onResponsableDone(true)}
        />
      {:else}
        <button
          type="button"
          onclick={() => {
            resending = true;
            resent = false;
          }}
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-lg border px-3 py-1.5 text-xs font-semibold"
        >
          {m.asso_lydia_resp_resend_button()}
        </button>
      {/if}
      {#if resent}
        <p class="text-green-ok text-xs" role="status">{m.asso_lydia_resp_resent()}</p>
      {/if}
    </div>
  {/snippet}

  {#if accountFailed}
    <p class="text-red-err text-sm" role="alert">{m.asso_lydia_account_error()}</p>
    <button
      type="button"
      onclick={() => void loadAccount()}
      class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold"
    >
      {m.asso_payments_provider_retry()}
    </button>
  {:else if !account || !view}
    <p class="text-text-muted text-sm">{m.asso_lydia_account_loading()}</p>
  {:else if view.active}
    <p class="text-text-main flex flex-wrap items-center gap-2 text-sm font-semibold">
      {m.asso_lydia_active_title()}
      <span
        class="text-green-ok bg-green-ok/20 text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
      >
        {m.asso_lydia_status_active()}
      </span>
    </p>
    {#if account.responsable}
      <p class="text-text-muted text-sm">
        {m.asso_lydia_resp_done({
          name: account.responsable.name,
          phoneEnd: account.responsable.phoneEnd,
        })}
      </p>
    {:else if view.recordResponsable}
      <div class="space-y-2">
        <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_resp_record_intro()}</p>
        <LydiaResponsableForm
          associationId={asso.id}
          mode="record"
          submitLabel={m.asso_lydia_resp_record_button()}
          onDone={() => onResponsableDone(false)}
        />
      </div>
    {/if}
    {@render adminAndDisconnect(false)}
  {:else}
    <ol class="space-y-5">
      {#each view.steps as step, index (step.id)}
        <li class="flex gap-3" aria-current={step.state === 'current' ? 'step' : undefined}>
          <span
            class="{step.state === 'done'
              ? 'bg-green-ok/20 text-green-ok'
              : step.state === 'current' || step.state === 'in-flight'
                ? 'bg-cn-yellow text-cn-ink'
                : step.state === 'paused'
                  ? 'bg-red-err/10 text-red-err'
                  : 'bg-cn-bg text-text-muted'} text-2xs mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-bold"
          >
            {#if step.state === 'done'}<Check size={14} />{:else}{index + 1}{/if}
          </span>
          <div class="min-w-0 flex-1 space-y-3">
            <p class="text-text-main text-sm font-semibold">
              {stepTitle(step)}
              <span class="sr-only">({stepStateLabel(step)})</span>
            </p>

            {#if step.id === 'details'}
              {#if step.state === 'in-flight'}
                <p class="text-amber-warn text-sm leading-relaxed" role="status">
                  {m.asso_lydia_in_flight_notice()}
                </p>
                {#if view.adminCanClearInFlight}
                  <button
                    type="button"
                    onclick={() => void handleClearInFlight()}
                    disabled={clearing}
                    class="border-cn-border text-text-main hover:bg-cn-bg rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    {clearing
                      ? m.asso_lydia_in_flight_clear_loading()
                      : m.asso_lydia_in_flight_clear_button()}
                  </button>
                {/if}
              {:else if step.state === 'current'}
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
                  <Input
                    label={m.asso_lydia_city_label()}
                    bind:value={city}
                    required
                    disabled={submitting}
                  />
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
            {:else if step.id === 'responsable'}
              {#if account.responsable}
                <p class="text-text-muted text-sm">
                  {m.asso_lydia_resp_done({
                    name: account.responsable.name,
                    phoneEnd: account.responsable.phoneEnd,
                  })}
                </p>
                {@render resendControl(account.responsable)}
              {:else if step.state === 'current'}
                <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_resp_intro()}</p>
                <LydiaResponsableForm
                  associationId={asso.id}
                  mode="add"
                  submitLabel={m.asso_lydia_resp_send_button()}
                  onDone={() => onResponsableDone(false)}
                />
              {/if}
            {:else if step.id === 'activate'}
              {#if step.state === 'current' && account.responsable}
                <ul class="text-text-muted list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                  <li>{m.asso_lydia_activate_app({ phoneEnd: account.responsable.phoneEnd })}</li>
                  <li>{m.asso_lydia_activate_console()}</li>
                  <li>
                    {m.asso_lydia_activate_docs()}
                    <ul class="list-[circle] space-y-0.5 pl-5">
                      <li>{m.asso_lydia_doc_prefecture()}</li>
                      <li>{m.asso_lydia_doc_minutes()}</li>
                      <li>{m.asso_lydia_doc_rib()}</li>
                      <li>{m.asso_lydia_doc_identity()}</li>
                    </ul>
                  </li>
                </ul>
              {/if}
            {:else if step.id === 'validation'}
              {#if view.pause}
                <p class="text-red-err text-sm leading-relaxed" role="status">
                  {m.asso_lydia_paused({
                    date: formatPauseDate(view.pause.at),
                    cause:
                      view.pause.cause === 'request-blocked'
                        ? m.asso_lydia_paused_blocked()
                        : m.asso_lydia_paused_refused(),
                  })}
                </p>
                <p class="text-text-muted text-sm leading-relaxed">
                  {m.asso_lydia_paused_admin_check()}
                </p>
              {:else if step.state === 'current'}
                <p class="text-text-muted text-sm leading-relaxed">
                  {m.asso_lydia_validation_waiting()}
                </p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    {#if account.lydiaAccountId}
      {@render adminAndDisconnect(view.adminCanValidate)}
    {/if}
  {/if}

  {#if error}
    <div class="text-red-err text-sm">{error}</div>
  {/if}
</div>
