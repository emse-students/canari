<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import PinAccountField from './PinAccountField.svelte';
  import {
    LoaderCircle,
    FingerprintPattern,
    LogOut,
    TriangleAlert,
    Delete,
    Info,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { isValidPin } from '$lib/utils/chat/pinValidation';
  import { isCoarsePointerDevice } from '$lib/utils/pointerDevice';

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
    /** The signed-in account's id, filed with the PIN by a password manager (see `PinAccountField`). */
    account?: string;
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
    account = '',
  }: Props = $props();

  let pin = $state('');
  let internalError = $state('');
  /**
   * The `<form>`'s id, so the submit button can live in the modal FOOTER and still submit it.
   * A constant rather than a literal typed twice, because the two spellings are what would drift -
   * and a submit button whose `form=` names nothing is a button that silently does nothing.
   */
  const FORM_ID = 'encryption-pin-form';

  let showForgotPin = $state(false);
  /** The "forgot PIN" box, kept so opening it can bring its reset button above the fixed footer. */
  let forgotBox = $state<HTMLElement | null>(null);

  /**
   * OPENING THE BOX SCROLLS IT INTO VIEW, because it opens BELOW the fold of the form's scroll
   * region and the unlock footer is outside that region (iPhone 12, 2026-10-07: "Reinitialiser mon
   * PIN" sat under the footer until a drag started on the keypad, and a tap on its coordinates hit
   * "Deverrouiller"). The footer must not scroll, so the box goes to the button, not the reverse.
   */
  $effect(() => {
    if (!showForgotPin) return;
    void tick().then(() => {
      console.debug('[PIN] forgot box opened, scrolling its reset button into view');
      forgotBox?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  });
  // The "stay signed in" explanation is one tap away instead of four lines under the checkbox.
  let showStayInfo = $state(false);

  /** The keypad's ten digits, in rows of three with the zero centred under the last row. */
  const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
  // Set for the round trip of the sign-out so the button cannot be pressed twice.
  let signingOut = $state(false);
  // Two-step guard so a single tap never triggers the destructive PIN reset.
  let confirmReset = $state(false);
  // Default to numpad on touch devices, keyboard input on desktop.
  let useNumpad = $state(true);
  onMount(() => {
    // `pointerDevice.ts` already owned this question; writing the query out again was a second copy
    // of it, and a copy is what lets one of them drift.
    useNumpad = isCoarsePointerDevice();
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

  /** Appends one digit. Never logs the digit: a PIN must not reach a log, even one character of it. */
  function pressDigit(digit: string) {
    internalError = '';
    pin = pin + digit;
  }

  /** Removes the last digit; a no-op on an empty PIN. */
  function pressBackspace() {
    internalError = '';
    pin = pin.slice(0, -1);
  }

  /** Switches between the keypad and the text field, clearing what was typed in the other one. */
  function switchInputMode(toKeypad: boolean) {
    Log.d('[pin-modal] input mode ->', toKeypad ? 'keypad' : 'manual');
    pin = '';
    useNumpad = toKeypad;
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
  phoneFullScreen
  showTitleBar={false}
  onClose={onClose ?? (() => {})}
>
  <!--
    A LOCK SCREEN, NOT A FORM UNDER A TITLE BAR (user, 2026-09-30: the sheet was "vraiment pas ouf,
    jolie, ergonomique"). The bar is gone - the heading is drawn here, under the app mark - and the
    screen is ordered by what the task needs: who is asking (mark + one title + one line), the dots
    that answer "how far am I", then the keypad, which is the centre of the screen. Everything else
    is quiet: two text links, one compact row for the stay-signed-in option whose explanation opens
    on demand, and the sign-out under the unlock button.

    THE CLUSTER IS CENTRED WITH `m-auto` INSIDE A SCROLL REGION, which is the safe way to centre:
    when the content is taller than the screen (200 % text on a short phone) the auto margins
    collapse to zero and the top stays reachable, where `justify-center` would clip it above the
    scrollport. The footer is still outside that region (`PinModal.exits` pins it), so the unlock
    button and the way out never scroll.

    NO AUTO-SUBMIT: a PIN here is 4 to 8 digits (`isValidPin`) and the code has no notion of a
    complete one, so submitting at the fourth digit would make every longer PIN impossible.
  -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 pt-4 pb-2">
    <form
      id={FORM_ID}
      onsubmit={handleSubmit}
      class="m-auto flex w-full max-w-xs flex-col items-center gap-4 py-2"
    >
      <PinAccountField {account} />
      <header class="flex flex-col items-center gap-2 text-center">
        <div
          class="bg-cn-ink flex size-16 items-center justify-center rounded-2xl border border-white/10 shadow-lg [@media(max-height:700px)]:hidden"
          aria-hidden="true"
        >
          <img src="/favicon.svg" alt="" class="size-11 object-contain" />
        </div>
        <h1 class="text-text-main text-xl font-semibold">
          {isFirstSetup ? m.auth_pin_title_setup() : m.auth_pin_title()}
        </h1>
        <p class="text-text-muted text-sm">
          {isFirstSetup ? m.auth_pin_setup_lead() : m.auth_pin_unlock_desc()}
        </p>
        {#if isFirstSetup && useNumpad}
          <p class="text-text-muted text-xs">{m.auth_pin_hint_setup_short()}</p>
        {/if}
      </header>

      {#if useNumpad}
        <!-- The dots: the focal point. Empty, filled, and (on a refusal) red with one shake. -->
        <div
          aria-hidden="true"
          class="flex items-center justify-center gap-4 py-1 {displayError ? 'pin-shake' : ''}"
        >
          {#each Array(Math.max(pin.length, 4)) as _, i (i)}
            <span
              class="size-3.5 rounded-full transition-all duration-150 {i < pin.length
                ? displayError
                  ? 'bg-red-err scale-110'
                  : 'bg-cn-yellow scale-110'
                : displayError
                  ? 'bg-red-err/30'
                  : 'bg-text-muted/30'}"
            ></span>
          {/each}
        </div>

        <!-- The error's line is reserved, so a refusal does not push the keypad down. -->
        <div class="-mt-2 min-h-5 text-center">
          {#if displayError}
            <p role="alert" class="text-red-err text-sm font-medium">{displayError}</p>
          {/if}
        </div>

        <div
          class="grid grid-cols-3 gap-x-5 gap-y-3 [@media(min-height:800px)]:gap-y-4"
          role="group"
          aria-label={m.auth_pin_numeric_keypad()}
        >
          {#each [...DIGITS, '', '0', '⌫'] as key (key)}
            {#if key === ''}
              {#if showBiometricButton && onBiometricRequest}
                <button
                  type="button"
                  onclick={onBiometricRequest}
                  disabled={isLoading}
                  class="pin-key text-cn-yellow rounded-full transition-all active:scale-95 disabled:opacity-50"
                >
                  <FingerprintPattern size={26} />
                  <span class="sr-only">{m.auth_pin_use_fingerprint()}</span>
                </button>
              {:else}
                <span aria-hidden="true"></span>
              {/if}
            {:else if key === '⌫'}
              <button
                type="button"
                disabled={isLoading || !pin}
                onclick={pressBackspace}
                aria-label={m.auth_pin_delete_digit()}
                class="pin-key text-text-muted hover:text-text-main rounded-full transition-all active:scale-95 disabled:opacity-30"
              >
                <Delete size={26} />
              </button>
            {:else}
              <button
                type="button"
                disabled={isLoading}
                onclick={() => pressDigit(key)}
                class="pin-key text-text-main rounded-full bg-black/5 text-2xl font-medium transition-all hover:bg-black/10 active:scale-95 active:bg-black/15 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/15 dark:active:bg-white/20"
              >
                {key}
              </button>
            {/if}
          {/each}
        </div>
      {:else}
        {#if showBiometricButton && onBiometricRequest}
          <button
            type="button"
            onclick={onBiometricRequest}
            disabled={isLoading}
            class="border-cn-border/60 text-text-main flex w-full items-center justify-center gap-2 rounded-2xl border py-3 text-sm font-semibold transition-all hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
          >
            <FingerprintPattern size={18} />
            {m.auth_pin_use_fingerprint()}
          </button>
        {/if}

        <!-- Text input (alphanumeric PINs, and any desktop) -->
        <div class="w-full space-y-2">
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
            class="border-cn-border/60 focus:border-cn-yellow focus:ring-cn-yellow/30 placeholder:text-text-muted/50 w-full rounded-2xl border bg-black/5 px-4 py-3.5 text-center font-mono text-2xl tracking-[0.4em] transition-all placeholder:tracking-normal focus:ring-2 focus:outline-none disabled:opacity-50 dark:bg-white/5 {displayError
              ? 'border-red-err pin-shake'
              : ''}"
          />
          <p class="text-text-muted text-center text-xs">
            {isFirstSetup ? m.auth_pin_hint_setup_long() : m.auth_pin_hint_returning()}
          </p>
          <div class="min-h-5 text-center">
            {#if displayError}
              <p role="alert" class="text-red-err text-sm font-medium">{displayError}</p>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Quiet secondary actions: two short text links, never a block of prose. -->
      <div class="flex flex-wrap items-center justify-center gap-x-1">
        <button
          type="button"
          onclick={() => switchInputMode(!useNumpad)}
          class="text-text-muted hover:text-text-main tap-target rounded-full px-3 py-2 text-xs font-medium transition-colors"
        >
          {useNumpad ? m.auth_pin_manual_entry() : m.auth_pin_numeric_keypad()}
        </button>
        {#if !isFirstSetup}
          <button
            type="button"
            aria-expanded={showForgotPin}
            onclick={() => (showForgotPin = !showForgotPin)}
            class="text-text-muted hover:text-text-main tap-target rounded-full px-3 py-2 text-xs font-medium transition-colors"
          >
            {m.auth_pin_forgot()}
          </button>
        {/if}
      </div>

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

      {#if !isFirstSetup && showForgotPin}
        <div
          bind:this={forgotBox}
          class="w-full scroll-mb-2 space-y-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3"
        >
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
                class="block w-full rounded-xl bg-red-500 py-2.5 text-center text-xs font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {m.auth_pin_reset_confirm()}
              </button>
            {:else}
              <button
                type="button"
                disabled={isLoading}
                onclick={() => (confirmReset = true)}
                class="block w-full rounded-xl border border-red-500/30 py-2 text-center text-xs font-semibold text-red-500 transition-colors hover:border-red-400/40 hover:bg-red-500/5 hover:text-red-400 disabled:opacity-50"
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

      {#if showStaySignedIn}
        <div class="w-full">
          <div
            class="flex items-center gap-1 rounded-2xl bg-black/5 py-1 pr-1 pl-4 dark:bg-white/5 {isLoading
              ? 'pointer-events-none opacity-50'
              : ''}"
          >
            <!--
              `data-stay-signed-in` is a test handle, and it is here for the same reason the change-PIN
              button carries one: this checkbox has no accessible name of its own (the label's text sits
              in a sibling `<span>`, and it is a Paraglide message that may be reworded in either
              locale), so the only other way to reach it is `input[type=checkbox]` over the whole
              document - which is a POSITION, and would silently move to another box the day the modal
              grows a second one.
            -->
            <label class="flex min-h-11 flex-1 cursor-pointer items-center gap-3 select-none">
              <input
                type="checkbox"
                data-stay-signed-in
                bind:checked={staySignedIn}
                disabled={isLoading}
                class="border-cn-border/60 accent-cn-yellow size-5 shrink-0 rounded"
              />
              <span class="text-text-main text-sm font-medium">{m.auth_pin_stay_signed_in()}</span>
            </label>
            <button
              type="button"
              aria-expanded={showStayInfo}
              aria-label={m.auth_pin_info_toggle()}
              onclick={() => (showStayInfo = !showStayInfo)}
              class="ui-icon-button text-text-muted hover:text-text-main rounded-full"
            >
              <Info size={18} />
            </button>
          </div>
          {#if showStayInfo}
            <p class="text-text-muted px-4 pt-2 text-xs leading-relaxed">
              {m.auth_pin_stay_signed_in_desc()}
            </p>
          {/if}
        </div>
      {/if}
    </form>
  </div>

  <!--
    THE TWO WAYS PAST THIS GATE DO NOT SCROLL, AND THAT IS THE WHOLE POINT OF THE SNIPPET.

    Both buttons used to be the last two blocks of the form, inside the modal body - which is
    `overflow-y-auto` in a panel capped at `max-h-[92dvh]`, so nothing was ever CUT and the defect
    was invisible to any "does it overflow" check. Measured on W3 with the numeric keypad, 2026-09-15:
    at 360 x 640 the form stood 928 px in a 530 px scrollport and **the unlock button ended 195 px
    below the fold, the sign-out button some 398 px** - a person could see the keypad, type their
    PIN, and not see the button that submits it.

    `Modal`'s footer is `shrink-0` and OUTSIDE the scrollport, so it cannot be pushed anywhere by the
    body's height. The submit reaches the form by `form={FORM_ID}` rather than by nesting.

    THE SIGN-OUT IS STILL THE APP'S ORDINARY ONE (`clearAuth` + `/login`): it ends the session and
    touches neither `mls.bin` nor the message database. It is drawn QUIET now - a text link under the
    unlock button - because the destructive reset, not this, is what needed a barrier. NOT disabled by
    `isLoading`: a submit that hangs is one of the states this button exists for.
  -->
  {#snippet footer()}
    <div class="mx-auto flex w-full max-w-xs flex-col items-center gap-1">
      <button
        type="submit"
        form={FORM_ID}
        disabled={isLoading}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold shadow-lg transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
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

      <button
        type="button"
        disabled={signingOut}
        onclick={() => void handleSignOut()}
        class="text-text-muted hover:text-text-main tap-target flex items-center justify-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50"
      >
        {#if signingOut}
          <LoaderCircle size={14} class="animate-spin" />
          {m.auth_pin_signing_out()}
        {:else}
          <LogOut size={14} />
          {m.auth_pin_sign_out()}
        {/if}
      </button>
    </div>
  {/snippet}
</Modal>

<style>
  /* The keypad's key box: 64 px, 72 px on a tall screen - bigger than the 44 px floor because this
     is the screen's one job. A class here rather than size utilities, so the icon-only keys
     (backspace, biometrics) do not declare a fifth `ui-icon-button` box. */
  .pin-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 4rem;
    height: 4rem;
  }

  @media (min-height: 800px) {
    .pin-key {
      width: 4.5rem;
      height: 4.5rem;
    }
  }

  /* One short shake when a PIN is refused. Reduced motion is honoured twice: here, and by the
     global rule in app.css that zeroes every animation duration. */
  .pin-shake {
    animation: pin-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }

  @keyframes pin-shake {
    10%,
    90% {
      transform: translateX(-1px);
    }
    20%,
    80% {
      transform: translateX(3px);
    }
    30%,
    50%,
    70% {
      transform: translateX(-6px);
    }
    40%,
    60% {
      transform: translateX(6px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pin-shake {
      animation: none;
    }
  }
</style>
