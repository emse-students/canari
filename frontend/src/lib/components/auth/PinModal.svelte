<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { LoaderCircle, FingerprintPattern, LogOut, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { isValidPin } from '$lib/utils/chat/pinValidation';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called with the entered PIN when the user submits the form. */
    onSubmit: (pin: string) => void;
    /**
     * Called when the user leaves the gate DELIBERATELY, which is now only the account-deletion
     * link below - the modal itself is not dismissible, so nothing else calls this.
     */
    onClose?: () => void;
    /**
     * Ends the session and leaves the encrypted state on the device. REQUIRED, and required is the
     * whole point: this modal blocks the app, so it must carry the way out itself. See the exit
     * button at the bottom of the form for what it is for.
     */
    onSignOut: () => void | Promise<void>;
    /** Called when the user taps the biometric authentication button. */
    onBiometricRequest?: () => void;
    /** Whether to render the biometric authentication button. */
    showBiometricButton?: boolean;
    /** Whether to render the "stay signed in on this device" opt-in checkbox. */
    showStaySignedIn?: boolean;
    /**
     * Two-way bound state of the "stay signed in" checkbox. When true, the caller persists
     * the device key vault across restarts (see `deviceKeyVault.setDeviceKeyPersistence`).
     */
    staySignedIn?: boolean;
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
    onSignOut,
    onBiometricRequest,
    showBiometricButton = false,
    showStaySignedIn = false,
    staySignedIn = $bindable(true),
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
  // Set for the round trip of the sign-out so the button cannot be pressed twice.
  let signingOut = $state(false);
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
    // Same minimum on setup and unlock: see pinValidation.ts for why no stricter rule may
    // apply to creation alone.
    if (!isValidPin(trimmed)) {
      internalError = m.auth_pin_min_length();
      return;
    }
    internalError = '';
    onSubmit(trimmed);
  }

  async function handleSignOut() {
    if (signingOut) return;
    signingOut = true;
    try {
      await onSignOut();
    } finally {
      signingOut = false;
    }
  }
</script>

<!--
  NOT DISMISSIBLE, AND THAT IS THE WHOLE OF THE FIX.

  Reported by the user on 2026-09-05: people who have forgotten their PIN close this modal instead
  of resetting it, and since it is raised again on the next page they walk the app closing it on
  every one. `pinrows.mjs --row 11` measured it on the local estate the same day - Escape closed the
  gate, a backdrop click closed the gate, and `exits: {signOut: 0, reset: 0, leaves: 0}` said the
  modal carried no way out at all in its default state, the reset and the account link both sitting
  behind a disclosure.

  A gate whose only property is that it comes back is not a gate: the session is unlocked-looking
  underneath it, every page renders, and the person is browsing an app whose messaging is dead
  without ever being told so. `dismissible={false}` closes Escape, the backdrop, the header button
  and the platform back gesture in one place (see `Modal.svelte` for why the fourth needed saying).

  `onClose` IS STILL HANDED DOWN, and deliberately - a modal that also swallowed the callback would
  be sealed twice, and the second seal would hide the first one failing. This way the flag is the
  only thing holding the gate shut, and `PinModal.gate.svelte.test.ts` can prove it by flipping it.

  AND CLOSING EVERY WAY OUT IS ONLY HALF OF IT - the other half is that there must BE a way out, or
  the fix is a softlock. The sign-out button at the bottom is that way out, and it is deliberately
  the app's ORDINARY sign-out (`clearAuth` + `/login`, the same gesture as the navbar's): it ends the
  session and touches neither `mls.bin` nor the message database, so the person who signs out here
  and remembers their PIN tomorrow finds their history where they left it. The destructive reset
  stays where it was, behind its disclosure and its two-step confirmation.
-->
<Modal
  {open}
  title={isFirstSetup ? m.auth_pin_title_setup() : m.auth_pin_title()}
  dismissible={false}
  onClose={onClose ?? (() => {})}
>
  <form onsubmit={handleSubmit} class="space-y-6 p-1">
    {#if isFirstSetup}
      <div class="border-cn-yellow/30 bg-cn-yellow/10 space-y-1.5 rounded-xl border px-4 py-3">
        <p class="text-cn-yellow text-sm font-semibold">
          {m.auth_pin_first_heading()}
        </p>
        <p class="text-text-muted text-sm leading-relaxed">
          {m.auth_pin_setup_p1()}<strong class="text-text-main">{m.auth_pin_never_sent()}</strong
          >{m.auth_pin_setup_p2()}<br />
          <strong class="text-text-main">{m.auth_pin_keep_safe()}</strong>
        </p>
      </div>
    {:else}
      <p class="text-text-muted text-center text-sm leading-relaxed">
        {m.auth_pin_unlock_desc()}
      </p>
    {/if}

    {#if showBiometricButton && onBiometricRequest}
      <button
        type="button"
        onclick={onBiometricRequest}
        disabled={isLoading}
        class="border-cn-border/60 text-text-main flex w-full items-center justify-center gap-2 rounded-xl border bg-white/5 py-3 text-sm font-semibold transition-all hover:bg-white/10 disabled:opacity-50 dark:bg-black/20 dark:hover:bg-black/30"
      >
        <FingerprintPattern size={18} />
        {m.auth_pin_use_fingerprint()}
      </button>

      <div class="flex items-center gap-3">
        <hr class="border-cn-border/40 flex-1" />
        <span class="text-text-muted text-xs">{m.auth_pin_or_enter()}</span>
        <hr class="border-cn-border/40 flex-1" />
      </div>
    {/if}

    {#if useNumpad}
      <!-- PIN dot display -->
      <div class="flex items-center justify-center gap-3 py-2">
        {#each Array(Math.max(pin.length, 4)) as _, i (i)}
          <span
            class="h-3.5 w-3.5 rounded-full transition-all duration-150 {i < pin.length
              ? 'bg-cn-yellow scale-110'
              : 'bg-black/15 dark:bg-white/20'}"
          ></span>
        {/each}
      </div>

      {#if displayError}
        <p class="-mt-1 text-center text-sm font-medium text-red-500">{displayError}</p>
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
              class="text-text-main h-14 rounded-2xl text-xl font-semibold transition-all active:scale-95 disabled:opacity-50
                {key === '⌫'
                ? 'bg-black/5 text-base dark:bg-white/10'
                : 'bg-black/5 hover:bg-black/10 dark:bg-white/8 dark:hover:bg-white/15'}"
            >
              {key}
            </button>
          {/if}
        {/each}
      </div>

      <p class="text-text-muted text-center text-xs">
        {isFirstSetup ? m.auth_pin_hint_setup_short() : m.auth_pin_hint_returning()}
        <button
          type="button"
          onclick={() => {
            pin = '';
            useNumpad = false;
          }}
          class="hover:text-text-main ml-1 underline transition-colors"
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
          inputmode={isFirstSetup ? 'numeric' : undefined}
          bind:value={pin}
          oninput={() => {
            internalError = '';
          }}
          disabled={isLoading}
          placeholder="••••••"
          class="border-cn-border/60 focus:border-cn-yellow focus:ring-cn-yellow/30 placeholder:text-text-muted/50 w-full rounded-xl border bg-white/5 px-4 py-3.5 text-center font-mono text-2xl tracking-[0.4em] transition-all placeholder:tracking-normal focus:ring-2 focus:outline-none disabled:opacity-50 dark:bg-black/20"
        />
        <p class="text-text-muted text-center text-xs">
          {isFirstSetup ? m.auth_pin_hint_setup_long() : m.auth_pin_hint_returning()}
          <button
            type="button"
            onclick={() => {
              pin = '';
              useNumpad = true;
            }}
            class="hover:text-text-main ml-1 underline transition-colors"
            >{m.auth_pin_numeric_keypad()}</button
          >
        </p>
        {#if displayError}
          <p class="text-center text-sm font-medium text-red-500">{displayError}</p>
        {/if}
      </div>
    {/if}

    {#if showStaySignedIn}
      <label
        class="flex cursor-pointer items-start gap-2.5 px-0.5 text-left select-none {isLoading
          ? 'pointer-events-none opacity-50'
          : ''}"
      >
        <input
          type="checkbox"
          bind:checked={staySignedIn}
          disabled={isLoading}
          class="border-cn-border/60 accent-cn-yellow mt-0.5 h-4 w-4 shrink-0 rounded"
        />
        <span class="text-text-muted text-xs leading-relaxed">
          <span class="text-text-main font-semibold">{m.auth_pin_stay_signed_in()}</span><br />
          {m.auth_pin_stay_signed_in_desc()}
        </span>
      </label>
    {/if}

    <button
      type="submit"
      disabled={isLoading}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-extrabold shadow-lg transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
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
        class="text-cn-yellow w-full text-center text-xs font-semibold hover:underline disabled:opacity-50"
      >
        {m.auth_pin_recover_link()}
      </button>
    {/if}

    <!-- Forgot PIN section (only for returning users) -->
    {#if !isFirstSetup}
      <div class="border-cn-border/30 border-t pt-4">
        <button
          type="button"
          onclick={() => (showForgotPin = !showForgotPin)}
          class="text-text-muted hover:text-text-main w-full text-center text-xs transition-colors"
        >
          {m.auth_pin_forgot()}
        </button>

        {#if showForgotPin}
          <div class="mt-3 space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
            <div class="flex items-start gap-2">
              <TriangleAlert size={16} class="mt-0.5 shrink-0 text-red-500" />
              <p class="text-text-muted text-xs leading-relaxed">
                {m.auth_pin_forgot_p1()}<strong class="text-text-main"
                  >{m.auth_pin_forgot_never_stored()}</strong
                >{m.auth_pin_forgot_p2()}
              </p>
            </div>

            {#if onForgotPinReset}
              <p class="text-text-muted text-xs leading-relaxed">
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
                  class="block w-full rounded-lg bg-red-500 py-2 text-center text-xs font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                >
                  {m.auth_pin_reset_confirm()}
                </button>
              {:else}
                <button
                  type="button"
                  disabled={isLoading}
                  onclick={() => (confirmReset = true)}
                  class="block w-full rounded-lg border border-red-500/30 py-1.5 text-center text-xs font-semibold text-red-500 transition-colors hover:border-red-400/40 hover:bg-red-500/5 hover:text-red-400 disabled:opacity-50"
                >
                  {m.auth_pin_reset_button()}
                </button>
              {/if}
            {/if}

            <a
              href="/profile"
              onclick={() => onClose?.()}
              class="text-text-muted hover:text-text-main block w-full py-1.5 text-center text-xs font-medium transition-colors"
            >
              {m.auth_pin_delete_account_link()}
            </a>
          </div>
        {/if}
      </div>
    {/if}

    <!--
      THE WAY OUT, AND IT IS ALWAYS ON SCREEN.

      Outside the "forgot PIN" disclosure on purpose: the person who needs it is by definition the
      person who cannot get past this modal, and an exit they have to go looking for is the softlock
      the fix above would otherwise create. Shown on the first setup too - someone who has just
      signed in and does not want to choose a PIN right now is stuck in exactly the same way.

      NOT disabled by `isLoading`. A submit that hangs is one of the states this button exists for,
      and the watchdog that unblocks the keypad is ten seconds long.
    -->
    <div class="border-cn-border/30 border-t pt-4">
      <button
        type="button"
        disabled={signingOut}
        onclick={() => void handleSignOut()}
        class="border-cn-border/60 text-text-muted hover:text-text-main flex w-full items-center justify-center gap-2 rounded-xl border bg-white/5 py-2.5 text-xs font-semibold transition-all hover:bg-white/10 disabled:opacity-50 dark:bg-black/20 dark:hover:bg-black/30"
      >
        {#if signingOut}
          <LoaderCircle size={14} class="animate-spin" />
          {m.auth_pin_signing_out()}
        {:else}
          <LogOut size={14} />
          {m.auth_pin_sign_out()}
        {/if}
      </button>
      <p class="text-text-muted mt-2 text-center text-xs leading-relaxed">
        {m.auth_pin_sign_out_desc()}
      </p>
    </div>
  </form>
</Modal>
