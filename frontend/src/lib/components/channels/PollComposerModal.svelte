<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { X, ChartColumn } from '@lucide/svelte';
  import PollOptionsEditor from '$lib/components/posts/PollOptionsEditor.svelte';
  import {
    emptyPollOptions,
    filledPollOptions,
    POLL_MIN_OPTIONS,
    type PollDraftOption,
  } from '$lib/posts/pollDraft';
  import type { ChannelPollDraft } from '$lib/utils/chat/channelCrypto';
  import { m } from '$lib/paraglide/messages';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';

  /**
   * Modal that lets a member compose a community poll (question, 2+ options,
   * single/multiple choice, optional deadline). Emits a {@link ChannelPollDraft}
   * with freshly generated opaque option ids; the actual encryption/send is the
   * caller's responsibility.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    onCreate: (draft: ChannelPollDraft) => void | Promise<void>;
  }

  let { open, onClose, onCreate }: Props = $props();

  let question = $state('');
  let options = $state<PollDraftOption[]>(emptyPollOptions());
  let multipleChoice = $state(false);
  let deadline = $state(''); // datetime-local value, '' = no deadline
  let submitting = $state(false);
  let error = $state('');

  const filledOptions = $derived(filledPollOptions(options));
  const canSubmit = $derived(
    question.trim().length > 0 && filledOptions.length >= POLL_MIN_OPTIONS
  );

  /** Resets the form to its initial empty state (after a successful send or close). */
  function reset() {
    question = '';
    options = emptyPollOptions();
    multipleChoice = false;
    deadline = '';
    error = '';
  }

  function close() {
    reset();
    onClose();
  }

  async function submit() {
    if (!canSubmit || submitting) return;
    const ts = deadline ? new Date(deadline).getTime() : 0;
    if (deadline && (Number.isNaN(ts) || ts <= Date.now())) {
      error = m.channel_poll_deadline_error();
      return;
    }
    submitting = true;
    error = '';
    try {
      await onCreate({
        question: question.trim(),
        // The opaque ids are minted HERE, where they always were - the editor holds only labels,
        // and a row's identity in the DOM is not the identity the protocol carries.
        // The ids were minted HERE, at submit, when a row had no identity of its own. The row
        // has carried one since 2026-09-23, so the option that is sent is the option that was
        // edited rather than a copy of its text.
        options: filledOptions,
        multipleChoice,
        endsAt: deadline ? new Date(deadline).toISOString() : null,
      });
      reset();
      onClose();
    } catch (e) {
      Log.d('poll.submit failed', e);
      error = m.channel_poll_create_error();
    } finally {
      submitting = false;
    }
  }
</script>

<!--
  THIS WAS THE GIF PICKER'S DEFECT, STILL IN PLACE. Like `GifPickerModal` before #585 it was a
  `fixed inset-0` overlay that was NOT portalled, so any transformed ancestor became its containing
  block and confined it to that ancestor's rectangle. It is opened from the channel composer today,
  which is near the root - so nobody had seen it yet. That is a latent defect, not a working one,
  and the fused overlay portals unconditionally.

  Its scrim also carried a raw `aria-label="Fermer"` - a French literal in a repo where every
  user-visible string is a Paraglide key, ten lines above a `m.common_close_label()` doing the same
  job correctly.
-->
<ModalOverlay
  {open}
  onClose={close}
  label={m.channel_poll_title()}
  layer="sheet"
  panelClass="flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-(--cn-surface) shadow-2xl sm:max-w-lg sm:rounded-2xl"
>
  <div class="border-cn-border flex items-center gap-2 border-b p-4">
    <ChartColumn size={18} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
    <h2 class="text-text-main flex-1 text-base font-bold">{m.channel_poll_title()}</h2>
    <button
      type="button"
      onclick={close}
      class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
      aria-label={m.common_close_label()}
    >
      <X size={18} />
    </button>
  </div>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
    <div>
      <label for="poll-question" class="text-text-main mb-1.5 block text-sm font-semibold">
        {m.post_poll_question_label()}
      </label>
      <input
        id="poll-question"
        bind:value={question}
        maxlength="300"
        placeholder={m.channel_poll_question_placeholder()}
        class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
      />
    </div>

    <PollOptionsEditor bind:options />

    <label
      class="flex cursor-pointer items-center justify-between rounded-xl bg-black/5 px-4 py-3 select-none dark:bg-white/5"
    >
      <span class="text-text-main text-sm font-semibold">{m.post_poll_allow_multiple_label()}</span>
      <input type="checkbox" bind:checked={multipleChoice} class="accent-cn-yellow h-5 w-5" />
    </label>

    <div>
      <label for="poll-deadline" class="text-text-main mb-1.5 block text-sm font-semibold">
        {m.poll_deadline_label()}
        <span class="text-text-muted font-normal">{m.poll_deadline_optional()}</span>
      </label>
      <input
        id="poll-deadline"
        type="datetime-local"
        bind:value={deadline}
        class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
      />
    </div>

    {#if error}
      <p class="text-sm font-medium text-red-500">{error}</p>
    {/if}
  </div>

  <div class="border-cn-border flex justify-end gap-2 border-t p-4">
    <button
      type="button"
      onclick={close}
      class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10"
    >
      {m.common_cancel_button()}
    </button>
    <button
      type="button"
      onclick={submit}
      disabled={!canSubmit || submitting}
      class="bg-cn-yellow text-cn-ink rounded-xl px-5 py-2 text-sm font-bold transition-all hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting ? m.common_sending_label() : m.channel_poll_submit_button()}
    </button>
  </div>
</ModalOverlay>
