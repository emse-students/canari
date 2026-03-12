<script lang="ts">
  import { Smile } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import 'emoji-picker-element';

  interface Props {
    visible: boolean;
    isOwn: boolean;
    onEmojiSelect?: (emoji: string) => void;
  }

  let { visible = false, isOwn = false, onEmojiSelect }: Props = $props();

  const RECENT_EMOJIS_KEY = 'canari_recent_emojis';
  let recentEmojis = $state<string[]>([]);

  function persistRecentEmoji(emoji: string) {
    const next = [emoji, ...recentEmojis.filter((item) => item !== emoji)].slice(0, 12);
    recentEmojis = next;
    try {
      localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage errors.
    }
  }

  function handleEmojiClick(emoji: string) {
    onEmojiSelect?.(emoji);
    persistRecentEmoji(emoji);
  }

  function attachEmojiPicker(node: HTMLElement) {
    const handleEmoji = (event: any) => {
      handleEmojiClick(event.detail.unicode);
    };
    node.addEventListener('emoji-click', handleEmoji);
    return {
      destroy() {
        node.removeEventListener('emoji-click', handleEmoji);
      },
    };
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem(RECENT_EMOJIS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        recentEmojis = parsed
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 12);
      }
    } catch {
      recentEmojis = [];
    }
  });
</script>

{#if visible}
  <div
    class="absolute top-full mt-2 {isOwn
      ? 'right-0'
      : 'left-0'} w-[min(92vw,22rem)] bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl z-[110] overflow-hidden"
  >
    <div
      class="px-3 py-2 border-b border-cn-border text-xs text-text-muted flex items-center gap-1.5"
    >
      <Smile size={12} /> Reagir au message
    </div>
    {#if recentEmojis.length > 0}
      <div class="px-3 py-2 border-b border-cn-border flex items-center gap-1 flex-wrap">
        <span class="text-[0.65rem] text-text-muted mr-1">Recents</span>
        {#each recentEmojis as emoji (emoji)}
          <button
            type="button"
            onclick={() => handleEmojiClick(emoji)}
            class="w-7 h-7 rounded-md hover:bg-cn-bg transition-colors text-base inline-flex items-center justify-center"
            aria-label={`Reagir avec ${emoji}`}
          >
            {emoji}
          </button>
        {/each}
      </div>
    {/if}
    <emoji-picker use:attachEmojiPicker class="light w-full" locale="fr"></emoji-picker>
  </div>
{/if}
