<script lang="ts">
  import { goto } from '$app/navigation';
  import { Trash2, LoaderCircle, CircleAlert } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { deleteMyAccount } from '$lib/stores/user';
  import { clearAuth } from '$lib/stores/auth';
  import { m } from '$lib/paraglide/messages';

  // Irreversible account deletion. The user must type the localized confirmation word to arm
  // the button, guarding against accidental clicks.
  const DELETION_CONFIRM_WORD = m.profile_delete_confirm_word();

  let deletionDialogOpen = $state(false);
  let deletionConfirmText = $state('');
  let deleting = $state(false);
  let deletionError = $state('');

  async function handleDeleteAccount() {
    if (deletionConfirmText !== DELETION_CONFIRM_WORD) return;
    deleting = true;
    deletionError = '';
    try {
      await deleteMyAccount();
      await clearAuth();
      await goto('/login', { replaceState: true });
    } catch (err) {
      deletionError = err instanceof Error ? err.message : m.profile_delete_error_fallback();
      deleting = false;
    }
  }
</script>

<div
  class="animate-in fade-in slide-in-from-bottom-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-6 shadow-sm delay-300 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-start gap-4">
    <div class="mt-0.5 shrink-0 rounded-xl bg-red-500/10 p-2.5 text-red-500">
      <Trash2 size={22} strokeWidth={2.5} />
    </div>
    <div class="min-w-0 flex-1">
      <h2 class="mb-1 text-lg font-extrabold text-red-500">{m.profile_delete_heading()}</h2>
      <p class="text-text-muted mb-4 text-sm leading-relaxed">
        {m.profile_delete_desc()}
      </p>
      {#if !deletionDialogOpen}
        <button
          onclick={() => {
            deletionDialogOpen = true;
            deletionConfirmText = '';
            deletionError = '';
          }}
          class="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-500 transition-all outline-none hover:bg-red-500/20 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95"
        >
          <Trash2 size={16} strokeWidth={2.5} />
          {m.profile_delete_heading()}
        </button>
      {:else}
        <div transition:slide={{ duration: 200 }} class="space-y-4">
          <p class="text-sm font-semibold text-red-400">
            {m.profile_delete_type_prompt({ word: DELETION_CONFIRM_WORD })}
          </p>
          <input
            type="text"
            bind:value={deletionConfirmText}
            placeholder={DELETION_CONFIRM_WORD}
            disabled={deleting}
            class="w-full max-w-xs rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5 font-mono text-sm font-bold text-red-400 placeholder-red-500/30 transition-all outline-none focus:border-red-500/60 focus:ring-2 focus:ring-red-500/20 disabled:opacity-50"
          />
          {#if deletionError}
            <p
              transition:slide={{ duration: 150 }}
              class="flex items-center gap-2 text-sm font-semibold text-red-500"
            >
              <CircleAlert size={16} />
              {deletionError}
            </p>
          {/if}
          <div class="flex gap-3">
            <button
              onclick={() => {
                deletionDialogOpen = false;
                deletionConfirmText = '';
              }}
              disabled={deleting}
              class="text-text-muted hover:text-text-main focus-visible:ring-text-muted rounded-xl px-4 py-2.5 text-sm font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 disabled:opacity-50 dark:hover:bg-white/5"
            >
              {m.common_cancel_button()}
            </button>
            <button
              onclick={handleDeleteAccount}
              disabled={deleting || deletionConfirmText !== DELETION_CONFIRM_WORD}
              class="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-red-500/20 transition-all outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-500/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {#if deleting}
                <LoaderCircle size={16} class="animate-spin" /> {m.profile_delete_deleting()}
              {:else}
                <Trash2 size={16} strokeWidth={2.5} /> {m.profile_delete_confirm_btn()}
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
