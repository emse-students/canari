<script lang="ts">
  import { scale } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { m } from '$lib/paraglide/messages';
  import { getRecentEmojis, persistRecentEmoji } from '$lib/components/messages/emojiPickerShared';
  import EmojiGrid from '$lib/components/messages/EmojiGrid.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';

  interface Props {
    open: boolean;
    /** The composer's own emoji button - the popover anchors to it and to nothing else. */
    anchor: HTMLElement | null;
    /**
     * Called with the picked emoji and whether Shift was held. The caller decides what that means
     * (closing the panel, adding a trailing space) - this component only reports the gesture.
     */
    onSelect: (emoji: string, shiftKey: boolean) => void;
  }

  let { open, anchor, onSelect }: Props = $props();

  let panelEl = $state<HTMLElement | null>(null);
  let unbindPosition: (() => void) | null = null;
  let recentEmojis = $state<string[]>([]);

  $effect(() => {
    if (open) recentEmojis = getRecentEmojis();
  });

  /**
   * Anchored to the composer's own button, the same mechanism `MessageEmojiPicker` uses for a
   * reaction - `computeFixedPopoverPosition` prefers the side with more room, and there is far more
   * room ABOVE a composer sitting at the bottom of the screen than below it, so this opens upward
   * without asking it to: the panel pops up just above the composer, never centred on the screen.
   */
  $effect(() => {
    if (!open || !panelEl || !anchor) {
      unbindPosition?.();
      unbindPosition = null;
      return;
    }

    unbindPosition?.();
    unbindPosition = bindFixedPopover(panelEl, {
      anchor: () => anchor,
      alignEnd: true,
      estimatedHeight: 440,
    });

    return () => {
      unbindPosition?.();
      unbindPosition = null;
    };
  });

  function handleEmojiClick(emoji: string, shiftKey: boolean) {
    onSelect(emoji, shiftKey);
    recentEmojis = persistRecentEmoji(emoji);
  }
</script>

{#if open}
  <div
    use:portal
    bind:this={panelEl}
    data-swipe-nav-ignore
    transition:scale={{ duration: 200, start: 0.95, opacity: 0, easing: (t) => t * (2 - t) }}
    class="bg-cn-surface fixed z-(--z-popover) flex w-[min(92vw,22rem)] flex-col overflow-hidden rounded-2xl border border-black/5 shadow-2xl shadow-black/10 dark:border-white/10 dark:shadow-black/40"
  >
    {#if recentEmojis.length > 0}
      <div
        class="flex flex-wrap items-center gap-1.5 border-b border-black/5 bg-white/20 px-3 py-2 dark:border-white/10 dark:bg-black/10"
      >
        <span class="text-text-muted/80 text-2xs mr-2 font-bold tracking-widest uppercase">
          {m.msg_recent_reactions_label()}
        </span>
        {#each recentEmojis as emoji (emoji)}
          <button
            type="button"
            onclick={(e) => handleEmojiClick(emoji, e.shiftKey)}
            class="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-lg shadow-sm transition-all hover:scale-110 hover:bg-black/10 hover:shadow-md dark:hover:bg-white/10"
            aria-label={m.chat_insert_emoji_label({ emoji })}
          >
            <EmojiText text={emoji} />
          </button>
        {/each}
      </div>
    {/if}

    <EmojiGrid onPick={handleEmojiClick} />
  </div>
{/if}
