<script lang="ts">
  import { Plus, Trash2 } from '@lucide/svelte';
  import {
    newPollOption,
    POLL_MAX_OPTIONS,
    POLL_MIN_OPTIONS,
    type PollDraftOption,
  } from '$lib/posts/pollDraft';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE INPUT PER OPTION, A `+` AND A BIN - THE EDITOR BOTH POLL COMPOSERS MOUNT.
   *
   * The channel composer has had this since it was written. The post composer had a textarea whose
   * label ("Options (une par ligne)") carried the entire structure of the data: a reader who typed
   * "Oui, Non" wrote ONE option, the publish was refused, and the refusal named nothing (user,
   * 2026-09-21). A line break is not a control a text box advertises, so it was the wrong control.
   *
   * IT KEYS ON THE OPTION'S OWN ID. `{#each}` needs a stable key or a row loses focus the moment
   * another is removed, and a label is not stable - it changes on every keystroke and two rows may
   * be blank at once. This editor briefly held a PARALLEL array of row ids and an `$effect` to
   * resync it whenever the caller replaced the options wholesale; carrying identity on the option
   * itself deletes both, and is the same fact the server needs to keep a vote attached to an
   * option across an edit.
   */
  interface Props {
    /** One entry per row, blanks included. Bindable - the caller owns the state. */
    options: PollDraftOption[];
    /** Rendered under the rows when the caller wants to say what is missing. */
    issue?: string;
  }

  let { options = $bindable(), issue }: Props = $props();

  const canRemove = $derived(options.length > POLL_MIN_OPTIONS);

  function addOption() {
    if (options.length >= POLL_MAX_OPTIONS) return;
    options = [...options, newPollOption()];
  }

  function removeOption(index: number) {
    if (!canRemove) return;
    options = options.filter((_, i) => i !== index);
  }
</script>

<div class="space-y-2">
  <span class="text-text-main block text-sm font-bold">{m.poll_options_label()}</span>

  {#each options as option, index (option.id)}
    <div class="flex items-center gap-2">
      <input
        bind:value={option.label}
        maxlength="150"
        placeholder={m.poll_option_placeholder({ position: index + 1 })}
        class="border-cn-border/70 bg-cn-surface text-text-main focus:border-cn-yellow focus:ring-cn-yellow/25 w-full rounded-xl border px-4 py-2.5 text-sm font-medium shadow-sm transition-all outline-none focus:ring-2"
      />
      <button
        type="button"
        onclick={() => removeOption(index)}
        disabled={!canRemove}
        class="ui-icon-button text-text-muted hover:text-text-main shrink-0 rounded-xl transition-colors hover:bg-black/5 disabled:opacity-25 dark:hover:bg-white/10"
        aria-label={m.poll_remove_option_aria({ position: index + 1 })}
      >
        <Trash2 size={16} />
      </button>
    </div>
  {/each}

  {#if options.length < POLL_MAX_OPTIONS}
    <button
      type="button"
      onclick={addOption}
      class="text-cn-yellow hover:bg-cn-yellow/10 flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm font-bold transition-colors"
    >
      <Plus size={16} strokeWidth={2.5} />
      {m.poll_add_option()}
    </button>
  {/if}

  {#if issue}
    <p class="text-2xs pt-0.5 font-bold text-red-600 dark:text-red-400">{issue}</p>
  {/if}
</div>
