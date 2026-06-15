<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { LoaderCircle, Fingerprint, AlertTriangle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called with the entered PIN when the user submits the form. */
    onSubmit: (pin: string) => void;
    /** Called when the user dismisses the modal without submitting. */
    onClose?: () => void;
    /** Called when the user taps the biometric authentication button. */
    onBiometricRequest?: () => void;
    /** Whether to render the biometric authentication button. */
    showBiometricButton?: boolean;
    /** Error message set by the parent (e.g. wrong PIN); displayed below the input. */
    externalError?: string;
    /** Whether a login attempt is in progress; disables inputs and shows a spinner. */
    isLoading?: boolean;
    /** Current login step label shown in the submit button during loading (e.g. "Chargement MLS…"). */
    loadingStep?: string;
    /**
     * True when this is the very first time the user sets up their PIN on any device.
     * Shows a "choose and save your PIN" message instead of the standard unlock message.
     */
    isFirstSetup?: boolean;
    /**
     * Called when the user confirms a "forgot PIN" reset. When provided, the modal
     * offers a reset option that wipes the PIN-protected messaging state (keeping the
     * account) instead of only pointing to full account deletion. Omit to hide it.
     */
    onForgotPinReset?: () => void;
    /**
     * Called when the user chooses to recover after the PIN was changed on another device.
     * Provided by the parent only when recovery is applicable (a mismatch occurred and a
     * local MLS state exists). When set, a "PIN changed elsewhere → recover" link is shown.
     */
    onRecoverPin?: () => void;
  }

  let {
    open,
    onSubmit,
    onClose,
    onBiometricRequest,
    showBiometricButton = false,
    externalError = '',
    isLoading = false,
    isFirstSetup = false,
    loadingStep = '',
    onForgotPinReset,
    onRecoverPin,
  }: Props = $props();

  let pin = $state('');
  let internalError = $state('');
  let showForgotPin = $state(false);
  // Two-step guard so a single tap never triggers the destructive PIN reset.
  let confirmReset = $state(false);
  // Default to numpad on touch devices, keyboard input on desktop.
  let useNumpad = $state(true);
  onMount(() => {
    useNumpad = window.matchMedia('(pointer: coarse)').matches;
  });

  $effect(() => {
    if (externalError) internalError = '';
  });

  const displayError = $derived(externalError || internalError);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = pin.trim();
    if (!trimmed) {
      internalError = m.auth_pin_required();
      return;
    }
    if (trimmed.length < 4) {
      internalError = m.auth_pin_min_length();
      return;
    }
    internalError = '';
    onSubmit(trimmed);
  }
</script>

<Modal
  {open}
  title={isFirstSetup ? m.auth_pin_title_setup() : m.auth_pin_title()}
  onClose={onClose ?? (() => {})}
>
  <form onsubmit={handleSubmit} class="space-y-6 p-1">
    {#if isFirstSetup}
      <div class="rounded-xl border border-cn-yellow/30 bg-cn-yellow/10 px-4 py-3 space-y-1.5">
        <p class="text-sm font-semibold text-cn-yellow">
          {m.auth_pin_first_heading()}
        </p>
        <p class="text-sm text-text-muted leading-relaxed">
          {m.auth_pin_setup_p1()}<strong class="text-text-main">{m.auth_pin_never_sent()}</strong
          >{m.auth_pin_setup_p2()}<br />
          <strong class="text-text-main">{m.auth_pin_keep_safe()}</strong>
        </p>
      </div>
    {:else}
      <p class="text-sm text-text-muted leading-relaxed text-center">
        {m.auth_pin_unlock_desc()}
      </p>
    {/if}

    {#if showBiometricButton && onBiometricRequest}
      <button
        type="button"
        onclick={onBiometricRequest}
        disabled={isLoading}
        class="w-full py-3 flex items-center justify-center gap-2 rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 text-sm font-semibold text-text-main hover:bg-white/10 dark:hover:bg-black/30 transition-all disabled:opacity-50"
      >
        <Fingerprint size={18} />
        {m.auth_pin_use_fingerprint()}
      </button>

      <div class="flex items-center gap-3">
        <hr class="flex-1 border-cn-border/40" />
        <span class="text-xs text-text-muted">{m.auth_pin_or_enter()}</span>
        <hr class="flex-1 border-cn-border/40" />
      </div>
    {/if}

    {#if useNumpad}
      <!-- PIN dot display -->
      <div class="flex items-center justify-center gap-3 py-2">
        {#each Array(Math.max(pin.length, 4)) as _, i (i)}
          <span
            class="w-3.5 h-3.5 rounded-full transition-all duration-150 {i < pin.length
              ? 'bg-cn-yellow scale-110'
              : 'bg-black/15 dark:bg-white/20'}"
          ></span>
        {/each}
      </div>

      {#if displayError}
        <p class="text-sm text-red-500 font-medium text-center -mt-1">{displayError}</p>
      {/if}

      <!-- Numeric keypad -->
      <div class="grid grid-cols-3 gap-2.5" aria-label={m.auth_pin_numeric_keypad()}>
        {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as key (key)}
          {#if key === ''}
            <span></span>
          {:else}
            <button
              type="button"
              disabled={isLoading}
              onclick={() => {
                internalError = '';
                if (key === '⌫') {
                  pin = pin.slice(0, -1);
                } else {
                  pin = pin + key;
                }
              }}
              class="h-14 rounded-2xl text-xl font-semibold text-text-main transition-all active:scale-95 disabled:opacity-50
                {key === '⌫'
                ? 'bg-black/5 dark:bg-white/10 text-base'
                : 'bg-black/5 dark:bg-white/8 hover:bg-black/10 dark:hover:bg-white/15'}"
            >
              {key}
            </button>
          {/if}
        {/each}
      </div>

      <p class="text-xs text-text-muted text-center">
        {isFirstSetup ? m.auth_pin_hint_setup_short() : m.auth_pin_hint_returning()}
        <button
          type="button"
          onclick={() => {
            pin = '';
            useNumpad = false;
          }}
          class="ml-1 underline hover:text-text-main transition-colors"
          >{m.auth_pin_manual_entry()}</button
        >
      </p>
    {:else}
      <!-- Text input fallback (alphanumeric PINs) -->
      <div class="space-y-2">
        <label for="encryption-pin" class="sr-only">{m.auth_pin_label()}</label>
        <input
          id="encryption-pin"
          type="password"
          autocomplete={isFirstSetup ? 'new-password' : 'current-password'}
          bind:value={pin}
          oninput={() => {
            internalError = '';
          }}
          disabled={isLoading}
          placeholder="••••••"
          class="w-full rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 px-4 py-3.5 text-center text-2xl tracking-[0.4em] font-mono focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/30 focus:outline-none transition-all placeholder:tracking-normal placeholder:text-text-muted/50 disabled:opacity-50"
        />
        <p class="text-xs text-text-muted text-center">
          {isFirstSetup ? m.auth_pin_hint_setup_long() : m.auth_pin_hint_returning()}
          <button
            type="button"
            onclick={() => {
              pin = '';
              useNumpad = true;
            }}
            class="ml-1 underline hover:text-text-main transition-colors"
            >{m.auth_pin_numeric_keypad()}</button
          >
        </p>
        {#if displayError}
          <p class="text-sm text-red-500 font-medium text-center">{displayError}</p>
        {/if}
      </div>
    {/if}

    <button
      type="submit"
      disabled={isLoading}
      class="w-full py-3.5 bg-cn-yellow text-[#151B2C] rounded-xl font-extrabold text-sm hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-cn-yellow/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:translate-y-0"
    >
      {#if isLoading}
        <LoaderCircle size={16} class="animate-spin" />
        {loadingStep || m.auth_pin_verifying()}
      {:else if isFirstSetup}
        {m.auth_pin_create()}
      {:else}
        {m.auth_pin_unlock()}
      {/if}
    </button>

    <!-- PIN changed on another device → recover messages (shown only when applicable) -->
    {#if !isFirstSetup && onRecoverPin && displayError}
      <button
        type="button"
        disabled={isLoading}
        onclick={() => onRecoverPin?.()}
        class="w-full text-xs font-semibold text-cn-yellow hover:underline text-center disabled:opacity-50"
      >
        {m.auth_pin_recover_link()}
      </button>
    {/if}

    <!-- Forgot PIN section (only for returning users) -->
    {#if !isFirstSetup}
      <div class="border-t border-cn-border/30 pt-4">
        <button
          type="button"
          onclick={() => (showForgotPin = !showForgotPin)}
          class="w-full text-xs text-text-muted hover:text-text-main transition-colors text-center"
        >
          {m.auth_pin_forgot()}
        </button>

        {#if showForgotPin}
          <div class="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 space-y-3">
            <div class="flex items-start gap-2">
              <AlertTriangle size={16} class="text-red-500 shrink-0 mt-0.5" />
              <p class="text-xs text-text-muted leading-relaxed">
                {m.auth_pin_forgot_p1()}<strong class="text-text-main"
                  >{m.auth_pin_forgot_never_stored()}</strong
                >{m.auth_pin_forgot_p2()}
              </p>
            </div>

            {#if onForgotPinReset}
              <p class="text-xs text-text-muted leading-relaxed">
                <strong class="text-text-main">{m.auth_pin_reset_strong1()}</strong
                >{m.auth_pin_reset_mid()}<strong class="text-text-main"
                  >{m.auth_pin_reset_strong2()}</strong
                >{m.auth_pin_reset_end()}
              </p>
              {#if confirmReset}
                <button
                  type="button"
                  disabled={isLoading}
                  onclick={() => {
                    confirmReset = false;
                    onForgotPinReset?.();
                  }}
                  class="block w-full text-center text-xs font-bold text-white bg-red-500 hover:bg-red-600 transition-colors py-2 rounded-lg disabled:opacity-50"
                >
                  {m.auth_pin_reset_confirm()}
                </button>
              {:else}
                <button
                  type="button"
                  disabled={isLoading}
                  onclick={() => (confirmReset = true)}
                  class="block w-full text-center text-xs font-semibold text-red-500 hover:text-red-400 transition-colors py-1.5 rounded-lg border border-red-500/30 hover:border-red-400/40 hover:bg-red-500/5 disabled:opacity-50"
                >
                  {m.auth_pin_reset_button()}
                </button>
              {/if}
            {/if}

            <a
              href="/profile"
              onclick={() => onClose?.()}
              class="block w-full text-center text-xs font-medium text-text-muted hover:text-text-main transition-colors py-1.5"
            >
              {m.auth_pin_delete_account_link()}
            </a>
          </div>
        {/if}
      </div>
    {/if}
  </form>
</Modal>
