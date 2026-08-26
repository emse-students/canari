<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { LoaderCircle, TriangleAlert, KeyRound } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import type { PinOperationProgress } from '$lib/utils/chat/pinChange';
  import { isValidPin } from '$lib/utils/chat/pinValidation';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called with the current and new PIN when the form passes local validation. */
    onSubmit: (currentPin: string, newPin: string) => void;
    /** Called when the user dismisses the modal. */
    onClose: () => void;
    /** Error message set by the parent (e.g. wrong current PIN); shown below the form. */
    externalError?: string;
    /** Whether a change attempt is in progress; disables inputs and shows a spinner. */
    isLoading?: boolean;
    /** Live progress for the in-flight PIN change / recovery operation. */
    loadingProgress?: PinOperationProgress | null;
    /**
     * 'change' (default): a logged-in user rotates their PIN.
     * 'recover': the PIN was changed on another device - the user types their OLD PIN
     * (to decrypt this device) plus the NEW account PIN to recover their messages.
     */
    variant?: 'change' | 'recover';
  }

  let {
    open,
    onSubmit,
    onClose,
    externalError = '',
    isLoading = false,
    loadingProgress = null,
    variant = 'change',
  }: Props = $props();

  const isRecover = $derived(variant === 'recover');
  const title = $derived(isRecover ? m.auth_changepin_title_recover() : m.auth_changepin_title());
  const currentLabel = $derived(
    isRecover ? m.auth_changepin_current_recover() : m.auth_changepin_current()
  );
  const newLabel = $derived(isRecover ? m.auth_changepin_new_recover() : m.auth_changepin_new());
  const submitLabel = $derived(
    isRecover ? m.auth_changepin_title_recover() : m.auth_changepin_title()
  );

  let currentPin = $state('');
  let newPin = $state('');
  let confirmPin = $state('');
  let internalError = $state('');

  // Reset the form whenever the modal is (re)opened so stale input never lingers.
  $effect(() => {
    if (open) {
      currentPin = '';
      newPin = '';
      confirmPin = '';
      internalError = '';
    }
  });

  const displayError = $derived(externalError || internalError);

  /** Maps a progress stage to a localized step label for the progress bar. */
  function progressLabel(progress: PinOperationProgress): string {
    const current = progress.current ?? 0;
    const total = progress.total ?? 0;
    switch (progress.stage) {
      case 'verify':
        return m.auth_changepin_progress_verify();
      case 'server':
        return m.auth_changepin_progress_server();
      case 'mls':
        return m.auth_changepin_progress_mls();
      case 'messages_decrypt':
        return m.auth_changepin_progress_messages_decrypt({ current, total });
      case 'messages_encrypt':
        return m.auth_changepin_progress_messages_encrypt({ current, total });
      case 'finalize':
        return m.auth_changepin_progress_finalize();
      case 'login':
        return m.auth_changepin_progress_login();
      default:
        return isRecover ? m.auth_changepin_recovering() : m.auth_changepin_changing();
    }
  }

  const progressCaption = $derived(loadingProgress ? progressLabel(loadingProgress) : '');

  function handleSubmit(e: Event) {
    e.preventDefault();
    const cur = currentPin.trim();
    const next = newPin.trim();
    const confirm = confirmPin.trim();
    if (!cur || !next || !confirm) {
      internalError = m.auth_changepin_fill_all();
      return;
    }
    // Same minimum in both modes. In 'recover' the "new" field is the PIN already chosen on
    // another device, so it could not take a stricter rule anyway.
    if (!isValidPin(next)) {
      internalError = m.auth_changepin_min_length();
      return;
    }
    if (next !== confirm) {
      internalError = m.auth_changepin_mismatch();
      return;
    }
    if (next === cur) {
      internalError = isRecover ? m.auth_changepin_diff_old() : m.auth_changepin_diff_current();
      return;
    }
    internalError = '';
    onSubmit(cur, next);
  }

  const inputClass =
    'w-full rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 px-4 py-3 text-center text-lg tracking-[0.3em] font-mono focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/30 focus:outline-none transition-all placeholder:tracking-normal placeholder:text-text-muted/50 disabled:opacity-50';
</script>

<Modal {open} {title} {onClose}>
  <form onsubmit={handleSubmit} class="space-y-5 p-1">
    <div class="border-cn-yellow/30 bg-cn-yellow/10 rounded-xl border px-4 py-3">
      {#if isRecover}
        <p class="text-text-muted text-sm leading-relaxed">
          {m.auth_changepin_recover_p1()}<strong class="text-text-main"
            >{m.auth_changepin_recover_old()}</strong
          >{m.auth_changepin_recover_p2()}<strong class="text-text-main"
            >{m.auth_changepin_recover_new()}</strong
          >{m.auth_changepin_recover_p3()}
        </p>
      {:else}
        <p class="text-text-muted text-sm leading-relaxed">
          {m.auth_changepin_change_p1()}<strong class="text-text-main"
            >{m.auth_pin_never_sent()}</strong
          >{m.auth_changepin_change_p2()}<strong class="text-text-main"
            >{m.auth_changepin_change_reconnect()}</strong
          >{m.auth_changepin_change_p3()}
        </p>
      {/if}
    </div>

    <div class="space-y-2">
      <label for="current-pin" class="text-text-muted block px-1 text-xs font-bold"
        >{currentLabel}</label
      >
      <input
        id="current-pin"
        type="password"
        autocomplete="current-password"
        bind:value={currentPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    <div class="space-y-2">
      <label for="new-pin" class="text-text-muted block px-1 text-xs font-bold">{newLabel}</label>
      <input
        id="new-pin"
        type="password"
        autocomplete="new-password"
        bind:value={newPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    <div class="space-y-2">
      <label for="confirm-pin" class="text-text-muted block px-1 text-xs font-bold"
        >{m.auth_changepin_confirm_label()}</label
      >
      <input
        id="confirm-pin"
        type="password"
        autocomplete="new-password"
        bind:value={confirmPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    {#if displayError}
      <p class="flex items-center gap-2 px-1 text-sm font-medium text-red-500">
        <TriangleAlert size={16} class="shrink-0" />
        {displayError}
      </p>
    {/if}

    {#if isLoading && loadingProgress}
      <div class="space-y-2 px-1" role="status" aria-live="polite">
        <div class="text-text-muted flex items-center justify-between gap-3 text-xs">
          <span class="truncate">{progressCaption}</span>
          <span class="shrink-0 font-mono tabular-nums">{loadingProgress.percent}%</span>
        </div>
        <div
          class="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
          aria-hidden="true"
        >
          <div
            class="bg-cn-yellow h-full rounded-full transition-[width] duration-300 ease-out"
            style="width: {loadingProgress.percent}%"
          ></div>
        </div>
      </div>
    {/if}

    <button
      type="submit"
      disabled={isLoading}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-extrabold shadow-lg transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
    >
      {#if isLoading}
        <LoaderCircle size={16} class="animate-spin" />
        {isRecover ? m.auth_changepin_recovering() : m.auth_changepin_changing()}
      {:else}
        <KeyRound size={16} strokeWidth={2.5} />
        {submitLabel}
      {/if}
    </button>
  </form>
</Modal>
