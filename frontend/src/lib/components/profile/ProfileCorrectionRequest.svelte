<script lang="ts">
  /**
   * The "request a correction" control on a person's OWN profile (D10). Only an admin edits a
   * profile, so this is the one way to get a wrong campus, formation or name changed: a message that
   * lands in the admin queue, and a notification when it is answered. It shows where the request
   * stands - waiting, applied or refused - so the person is never left to wonder.
   */
  import { onMount } from 'svelte';
  import { MessageSquareWarning, LoaderCircle } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import {
    CORRECTION_MESSAGE_MAX,
    fetchMyCorrection,
    profileErrorMessage,
    requestCorrection,
    type CorrectionRequest,
  } from '$lib/profile/profileEdit';

  let current = $state<CorrectionRequest | null>(null);
  let open = $state(false);
  let message = $state('');
  let sending = $state(false);
  let error = $state('');

  onMount(async () => {
    try {
      current = await fetchMyCorrection();
    } catch (err) {
      // The control is an extra: a failed read shows the button as if nothing were pending, and the
      // server's one-open-request rule still answers a duplicate with its own typed refusal.
      Log.d('profile.correction.load failed', err);
    }
  });

  async function send() {
    sending = true;
    error = '';
    try {
      current = await requestCorrection(message);
      open = false;
      message = '';
    } catch (err) {
      Log.d('profile.correction.send failed', err);
      error = profileErrorMessage(err);
    } finally {
      sending = false;
    }
  }

  const waiting = $derived(current?.status === 'pending');
</script>

<div class="mt-3 space-y-2 text-sm">
  {#if waiting}
    <p class="text-text-muted flex items-center gap-2">
      <MessageSquareWarning size={16} />
      {m.profile_correction_waiting()}
    </p>
  {:else}
    {#if current?.status === 'applied'}
      <p class="text-green-ok">{m.profile_correction_last_applied()}</p>
    {:else if current?.status === 'refused'}
      <p class="text-text-muted">
        {m.profile_correction_last_refused()}
        {#if current.resolutionNote}<span class="italic">- {current.resolutionNote}</span>{/if}
      </p>
    {/if}
    <button
      type="button"
      class="text-text-muted flex items-center gap-2 text-xs font-semibold hover:underline"
      onclick={() => (open = true)}
    >
      <MessageSquareWarning size={14} />
      {m.profile_correction_button()}
    </button>
  {/if}
</div>

{#if open}
  <Modal open title={m.profile_correction_title()} onClose={() => (open = false)}>
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p class="text-text-muted text-sm">{m.profile_correction_help()}</p>
      <textarea
        class="bg-cn-surface min-h-28 w-full rounded-xl border border-black/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10"
        bind:value={message}
        maxlength={CORRECTION_MESSAGE_MAX}
        placeholder={m.profile_correction_placeholder()}
        required></textarea>
      {#if error}
        <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-3 text-sm">
          {error}
        </div>
      {/if}
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5"
          onclick={() => (open = false)}
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="submit"
          disabled={sending || !message.trim()}
          class="bg-cn-yellow text-cn-dark flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {#if sending}<LoaderCircle size={14} class="animate-spin" />{/if}
          {m.profile_correction_send()}
        </button>
      </div>
    </form>
  </Modal>
{/if}
