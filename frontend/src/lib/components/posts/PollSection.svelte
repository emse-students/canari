<script lang="ts">
  import { X, ChartColumn } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import PollOptionsEditor from './PollOptionsEditor.svelte';
  import {
    filledPollOptions,
    POLL_MIN_OPTIONS,
    type PollDraftIssue,
    type PollDraftOption,
  } from '$lib/posts/pollDraft';
  import { m } from '$lib/paraglide/messages';

  /**
   * Collapsible card that lets the author configure a poll.
   * Rendered inside CreatePostForm and EditPostForm when the "Sondage" toolbar button is clicked.
   *
   * WHAT CHANGED ON 2026-09-23, AND WHY. The options were one textarea, newline separated, and the
   * structure of the data lived in its LABEL - so "Oui, Non" was one option and the post was
   * refused with a sentence that named nothing (user, 2026-09-21). They are rows now, through the
   * editor the channel composer already used. Two settings the server had always accepted arrive
   * with them: a closing time, which `PostPolls` has been able to render and count down for as
   * long as it has existed and which nothing could set on a post, and a cap on how many options
   * one voter may pick.
   *
   * AND IT SAYS WHAT IS MISSING WHERE IT IS MISSING. `issue` is the reader's half of the rule in
   * `pollDraft.ts`: the card names the field it is waiting on, rather than letting the reader find
   * out by tapping Publier and reading a sentence about a card they may have scrolled past.
   */
  interface Props {
    /** Poll question text. Bindable - parent owns the state. */
    question: string;
    /** One entry per option row, blanks included. Bindable. */
    options: PollDraftOption[];
    /** Whether voters can pick more than one option. Bindable. */
    multipleChoice: boolean;
    /** How many options one voter may pick, or `null` for no limit. Bindable. */
    maxSelections: number | null;
    /** `datetime-local` value at which the poll closes, or `''`. Bindable. */
    endsAt: string;
    /** What this draft is still missing, or `null` - shown beside the field it concerns. */
    issue?: PollDraftIssue | null;
    /** Called when the user clicks the remove (X) button. */
    onRemove: () => void;
  }

  let {
    question = $bindable(),
    options = $bindable(),
    multipleChoice = $bindable(),
    maxSelections = $bindable(),
    endsAt = $bindable(),
    issue = null,
    onRemove,
  }: Props = $props();

  const filledCount = $derived(filledPollOptions(options).length);
  /**
   * The caps worth offering: two up to "all but one".
   *
   * A cap equal to the number of options is not a cap, so it is not in the list - `normalizeMax
   * Selections` would drop it anyway, and offering a choice that silently becomes another one is
   * how a setting stops meaning what it says.
   */
  const capChoices = $derived(
    Array.from(
      { length: Math.max(0, filledCount - POLL_MIN_OPTIONS) },
      (_, i) => i + POLL_MIN_OPTIONS
    )
  );

  // A cap survives the removal of the options that justified it, and would then silently mean
  // something else. It is dropped as soon as it stops being offered.
  $effect(() => {
    if (maxSelections !== null && !capChoices.includes(maxSelections)) maxSelections = null;
  });
</script>

<div
  class="border-cn-border/60 bg-cn-surface rounded-2xl border p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]"
>
  <!-- Header row -->
  <div class="mb-4 flex items-center justify-between gap-2">
    <p class="text-text-muted text-2xs flex items-center gap-2 font-bold tracking-widest uppercase">
      <ChartColumn size={16} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
      {m.post_poll_section_title()}
    </p>
    <button
      type="button"
      onclick={onRemove}
      class="ui-icon-button text-text-muted hover:bg-cn-surface hover:text-text-main rounded-full transition-colors"
      title={m.post_poll_remove_label()}
    >
      <X size={16} />
    </button>
  </div>

  <div class="space-y-4">
    <div>
      <Input
        label={m.post_poll_question_label()}
        bind:value={question}
        placeholder={m.post_poll_question_placeholder()}
      />
      {#if issue === 'question'}
        <p class="text-2xs pt-1.5 font-bold text-red-600 dark:text-red-400">
          {m.post_poll_issue_question()}
        </p>
      {/if}
    </div>

    <PollOptionsEditor
      bind:options
      issue={issue === 'options' ? m.post_poll_issue_options() : undefined}
    />

    <!-- Multiple-choice toggle -->
    <label
      class="bg-cn-surface hover:bg-cn-border/30 flex cursor-pointer items-center justify-between rounded-xl px-4 py-3 transition-colors select-none dark:hover:bg-white/10"
    >
      <span class="text-text-main text-sm font-semibold">{m.post_poll_allow_multiple_label()}</span>
      <div class="relative flex items-center">
        <input type="checkbox" bind:checked={multipleChoice} class="peer sr-only" />
        <div
          class="peer-checked:bg-cn-yellow h-6 w-11 rounded-full bg-black/15 shadow-inner transition-colors duration-300 dark:bg-white/20"
        ></div>
        <div
          class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
        ></div>
      </div>
    </label>

    <!-- The cap only exists where it can mean something: two answers or more are allowed, and
         there are enough options for "some but not all" to be a distinction. -->
    {#if multipleChoice && capChoices.length > 0}
      <label class="block">
        <span class="text-text-main mb-2 ml-1 block text-sm font-bold"
          >{m.post_poll_max_selections_label()}</span
        >
        <select
          bind:value={maxSelections}
          class="border-cn-border/70 bg-cn-surface text-text-main focus:border-cn-yellow focus:ring-cn-yellow/25 w-full cursor-pointer appearance-none rounded-xl border px-4 py-3 text-sm font-medium shadow-sm transition-all outline-none focus:ring-2"
        >
          <option value={null}>{m.post_poll_max_selections_unlimited()}</option>
          {#each capChoices as choice (choice)}
            <option value={choice}>{m.post_poll_max_selections_option({ count: choice })}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label class="block">
      <span class="text-text-main mb-2 ml-1 block text-sm font-bold">
        {m.poll_deadline_label()}
        <span class="text-text-muted font-medium">{m.poll_deadline_optional()}</span>
      </span>
      <input
        type="datetime-local"
        bind:value={endsAt}
        class="border-cn-border/70 bg-cn-surface text-text-main focus:border-cn-yellow focus:ring-cn-yellow/25 w-full rounded-xl border px-4 py-3 text-sm font-medium shadow-sm transition-all outline-none focus:ring-2"
      />
      {#if issue === 'endsAt'}
        <p class="text-2xs pt-1.5 font-bold text-red-600 dark:text-red-400">
          {m.post_poll_issue_ends_at()}
        </p>
      {/if}
    </label>
  </div>
</div>
