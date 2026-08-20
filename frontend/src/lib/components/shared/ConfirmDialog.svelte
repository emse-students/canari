<script lang="ts">
  import { fly } from 'svelte/transition';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';
  import { confirmStore, resolveConfirm } from '$lib/stores/confirm.svelte';

  const pending = $derived(confirmStore.pending);

  /** What the user has typed, when the dialog asks for a typed confirmation. */
  let typed = $state('');

  // Every new dialog starts empty. Without this, a second delete would open already satisfied
  // by what was typed into the first one - which is the whole guard, gone.
  $effect(() => {
    void pending;
    typed = '';
  });

  const canConfirm = $derived(!pending?.requireText || typed.trim() === pending.requireText.trim());

  /**
   * Escape cancels, and nothing typed into the dialog reaches the app's own shortcuts.
   *
   * Bound on the dialog AND on the window because the dialog stops propagation: with the handler
   * only on the window, Escape worked exactly while focus was outside the dialog - which the focus
   * trap makes never. The typed confirmation made that certain rather than likely, since the input
   * takes focus on open.
   */
  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') resolveConfirm(false);
  }
</script>

<svelte:window onkeydown={pending ? handleKeydown : undefined} />

{#if pending}
  <div use:portal>
    <div
      role="presentation"
      class="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm px-4 pb-[env(safe-area-inset-bottom)]"
      onclick={() => resolveConfirm(false)}
      in:fly={{ duration: 150, opacity: 0 }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.message}
        tabindex="-1"
        use:focusTrap
        class="w-full max-w-sm rounded-2xl bg-[var(--cn-surface)] border border-cn-border shadow-2xl p-6 space-y-5"
        onclick={(e) => e.stopPropagation()}
        onkeydown={handleKeydown}
        in:fly={{ duration: 200, y: 16 }}
      >
        <p class="text-sm font-medium text-text-main leading-relaxed">{pending.message}</p>
        {#if pending.requireText}
          <div class="space-y-2">
            <p class="text-xs text-text-muted">{m.confirm_type_to_continue()}</p>
            <p class="text-sm font-bold text-text-main wrap-break-word select-all">
              {pending.requireText}
            </p>
            <!--
              NO `autofocus` HERE, and its absence is what makes the field focused rather than the
              other way round. Chrome refuses the attribute when something already holds focus -
              always the case, since the dialog is opened by a button the user just clicked - and
              logged "Autofocus processing was blocked because a document already has a focused
              element" on every community deletion, which is how it was found. `use:focusTrap` on
              the dialog focuses its first focusable child, and in DOM order that is this input; a
              programmatic focus is never blocked, so the attribute added a warning and nothing else.
            -->
            <input
              type="text"
              bind:value={typed}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              aria-label={m.confirm_type_to_continue()}
              placeholder={m.confirm_type_placeholder()}
              class="w-full px-3 py-2 rounded-xl bg-cn-border/30 border border-cn-border text-sm text-text-main placeholder:text-text-muted focus:outline-none focus:border-red-500 transition-colors"
            />
          </div>
        {/if}
        <div class="flex justify-end gap-2">
          <button
            onclick={() => resolveConfirm(false)}
            class="px-4 py-2 rounded-xl text-sm font-semibold text-text-muted hover:bg-cn-border/40 transition-colors"
          >
            {pending.cancelLabel}
          </button>
          <button
            onclick={() => resolveConfirm(true)}
            disabled={!canConfirm}
            class="px-4 py-2 rounded-xl text-sm font-bold transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              {pending.danger
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-cn-yellow hover:bg-cn-yellow-hover text-cn-dark'}"
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
