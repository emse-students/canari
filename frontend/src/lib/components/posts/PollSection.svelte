<script lang="ts">
  import { X, ChartColumn } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Collapsible card that lets the author configure a poll.
   * Rendered inside CreatePostForm when the user clicks the "Sondage" toolbar button.
   */
  interface Props {
    /** Poll question text. Bindable - parent owns the state. */
    question: string;
    /** Newline-separated list of answer options. Bindable. */
    optionsRaw: string;
    /** Whether voters can pick more than one option. Bindable. */
    multipleChoice: boolean;
    /** Called when the user clicks the remove (✕) button. */
    onRemove: () => void;
  }

  let {
    question = $bindable(),
    optionsRaw = $bindable(),
    multipleChoice = $bindable(),
    onRemove,
  }: Props = $props();
</script>

<div
  class="rounded-2xl border border-cn-border/60 bg-cn-surface/70 dark:bg-black/25 p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]"
>
  <!-- Header row -->
  <div class="mb-4 flex items-center justify-between gap-2">
    <p
      class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted"
    >
      <ChartColumn size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      {m.post_poll_section_title()}
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
      title={m.post_poll_remove_label()}
    >
      <X size={16} />
    </button>
  </div>

  <div class="space-y-4">
    <Input
      label={m.post_poll_question_label()}
      bind:value={question}
      placeholder={m.post_poll_question_placeholder()}
    />
    <Textarea label={m.post_poll_options_label()} bind:value={optionsRaw} rows={3} />

    <!-- Multiple-choice toggle -->
    <label
      class="flex cursor-pointer select-none items-center justify-between rounded-xl bg-cn-surface/80 px-4 py-3 transition-colors hover:bg-cn-border/30 dark:bg-white/5 dark:hover:bg-white/10"
    >
      <span class="text-sm font-semibold text-text-main">{m.post_poll_allow_multiple_label()}</span>
      <div class="relative flex items-center">
        <input type="checkbox" bind:checked={multipleChoice} class="peer sr-only" />
        <div
          class="h-6 w-11 rounded-full bg-black/15 shadow-inner transition-colors duration-300 peer-checked:bg-cn-yellow dark:bg-white/20"
        ></div>
        <div
          class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
        ></div>
      </div>
    </label>
  </div>
</div>
