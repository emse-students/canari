<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import type { Poll } from '$lib/posts/api';

  interface Props {
    polls: Poll[] | undefined;
    selectedOptions: string[];
    onToggleOption: (pollId: string, optionId: string, multipleChoice: boolean) => void;
    onSubmitVote: (pollId: string) => void;
  }

  let { polls, selectedOptions, onToggleOption, onSubmitVote }: Props = $props();
</script>

{#if polls && polls.length > 0}
  <div class="px-5 py-4 space-y-4 border-b border-cn-border/40">
    {#each polls as poll (poll.id)}
      <div class="rounded-xl border border-cn-border bg-[var(--cn-surface)]/30 p-4">
        <h4 class="font-bold mb-3 text-base text-text-main">{poll.question}</h4>
        <div class="space-y-2">
          {#each poll.options as option (option.id)}
            {@const isSelected = selectedOptions.includes(option.id)}
            <button
              class="w-full text-left p-3 rounded-xl border-2 transition-all flex justify-between items-center {isSelected
                ? 'border-cn-yellow bg-cn-yellow/5'
                : 'border-cn-border hover:border-cn-yellow/50 bg-[var(--cn-surface)]'}"
              onclick={() => onToggleOption(poll.id, option.id, poll.multipleChoice)}
            >
              <span class="font-medium text-sm">{option.label}</span>
              <span
                class="text-xs font-mono text-text-muted bg-[var(--cn-bg)] px-2 py-1 rounded-lg"
              >
                {option.votes} votes
              </span>
            </button>
          {/each}
        </div>
        <div class="mt-3 flex justify-end">
          <Button
            variant="primary"
            class="px-6 !py-2 !text-sm !rounded-xl"
            disabled={selectedOptions.length === 0}
            onclick={() => onSubmitVote(poll.id)}
          >
            Voter
          </Button>
        </div>
      </div>
    {/each}
  </div>
{/if}
