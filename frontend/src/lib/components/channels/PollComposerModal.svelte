<script lang="ts">
  import { X, Plus, Trash2, ChartColumn } from '@lucide/svelte';
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

  interface DraftOption {
    id: string;
    label: string;
  }

  let question = $state('');
  let options = $state<DraftOption[]>([
    { id: crypto.randomUUID(), label: '' },
    { id: crypto.randomUUID(), label: '' },
  ]);
  let multipleChoice = $state(false);
  let deadline = $state(''); // datetime-local value, '' = no deadline
  let submitting = $state(false);
  let error = $state('');

  const filledOptions = $derived(options.filter((o) => o.label.trim().length > 0));
  const canSubmit = $derived(question.trim().length > 0 && filledOptions.length >= 2);

  function addOption() {
    if (options.length >= 10) return;
    options = [...options, { id: crypto.randomUUID(), label: '' }];
  }

  function removeOption(id: string) {
    if (options.length <= 2) return;
    options = options.filter((o) => o.id !== id);
  }

  /** Resets the form to its initial empty state (after a successful send or close). */
  function reset() {
    question = '';
    options = [
      { id: crypto.randomUUID(), label: '' },
      { id: crypto.randomUUID(), label: '' },
    ];
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
        options: filledOptions.map((o) => ({ id: o.id, label: o.label.trim() })),
        multipleChoice,
        endsAt: deadline ? new Date(deadline).toISOString() : null,
      });
      reset();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : m.channel_poll_create_error();
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
        Question
      </label>
      <input
        id="poll-question"
        bind:value={question}
        maxlength="300"
        placeholder={m.channel_poll_question_placeholder()}
        class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
      />
    </div>

    <div class="space-y-2">
      <span class="text-text-main block text-sm font-semibold"
        >{m.channel_poll_options_label()}</span
      >
      {#each options as option (option.id)}
        <div class="flex items-center gap-2">
          <input
            bind:value={option.label}
            maxlength="150"
            placeholder={m.channel_poll_option_placeholder()}
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          />
          <button
            type="button"
            onclick={() => removeOption(option.id)}
            disabled={options.length <= 2}
            class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
            aria-label={m.channel_poll_remove_option_aria()}
          >
            <Trash2 size={16} />
          </button>
        </div>
      {/each}
      {#if options.length < 10}
        <button
          type="button"
          onclick={addOption}
          class="text-cn-yellow hover:bg-cn-yellow/10 flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm font-semibold"
        >
          <Plus size={16} />
          {m.channel_poll_add_option()}
        </button>
      {/if}
    </div>

    <label
      class="flex cursor-pointer items-center justify-between rounded-xl bg-black/5 px-4 py-3 select-none dark:bg-white/5"
    >
      <span class="text-text-main text-sm font-semibold">{m.post_poll_allow_multiple_label()}</span>
      <input type="checkbox" bind:checked={multipleChoice} class="accent-cn-yellow h-5 w-5" />
    </label>

    <div>
      <label for="poll-deadline" class="text-text-main mb-1.5 block text-sm font-semibold">
        {m.channel_poll_deadline_label()}
        <span class="text-text-muted font-normal">{m.channel_poll_deadline_optional()}</span>
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
