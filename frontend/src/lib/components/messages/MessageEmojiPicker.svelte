<script lang="ts">
  import { onMount } from 'svelte';
  import { scale } from 'svelte/transition';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';
  import {
    MAX_DISTINCT_MESSAGE_REACTIONS,
    canAddDistinctReactionEmoji,
  } from '$lib/utils/chat/messageReactions';
  import {
    pickerAlignsToEnd,
    pickerAnchor,
    type MessagePickerOrigin,
  } from '$lib/utils/chat/reactionPicker';
  import { getRecentEmojis, persistRecentEmoji } from './emojiPickerShared';
  import EmojiGrid from './EmojiGrid.svelte';
  import EmojiText from '../shared/EmojiText.svelte';

  interface Props {
    /**
     * Which control opened the panel, or `null` when it is closed - so this is its visibility too.
     *
     * `'toolbar'` is the "+" in the hover toolbar's quick bar, `'sheet'` the long-press actions.
     * They want different anchors, and the panel CANNOT tell them apart by looking (see below).
     */
    origin: MessagePickerOrigin;
    /** When true, anchors the picker to the right side (own messages). */
    isOwn: boolean;
    /** DOM node used to position the picker (message row). */
    anchor?: HTMLElement | null;
    /** Emoji types already present on the message. */
    existingReactionEmojis?: string[];
    /** Called when the user picks an emoji. */
    onEmojiSelect?: (emoji: string) => void;
  }

  let {
    origin = null,
    isOwn = false,
    anchor = null,
    existingReactionEmojis = [],
    onEmojiSelect,
  }: Props = $props();

  const reactionsAtLimit = $derived(
    existingReactionEmojis.length >= MAX_DISTINCT_MESSAGE_REACTIONS
  );

  let panelEl = $state<HTMLElement | null>(null);
  let unbindPosition: (() => void) | null = null;

  /**
   * THE PANEL OPENS BESIDE THE CONTROL THAT OPENED IT, NOT BESIDE THE MESSAGE.
   *
   * `anchor` is the message ROW, and on a wide thread a row is most of the window - so aligning to
   * its edge put the panel a screen away from the "+" that had just been pressed. The user's report
   * was that plainly (2026-09-09): *"lorsque je clique sur + sur la barre de smiley, le panneau ne
   * devrait pas s'ouvrir a l'autre bout de l'ecran"*.
   *
   * Which node that is depends on `origin` and on NOTHING this component can observe - the reasoning
   * and the defect that proved it are in `reactionPicker.ts`.
   *
   * Resolved at OPEN time rather than derived: the strip is created and destroyed by hover, so a
   * value computed once would name a node that no longer exists.
   */
  const positioningAnchor = () =>
    pickerAnchor(
      origin,
      anchor,
      anchor?.querySelector<HTMLElement>('[data-message-toolbar]') ?? null
    );

  $effect(() => {
    if (!origin || !panelEl || !anchor) {
      unbindPosition?.();
      unbindPosition = null;
      return;
    }

    unbindPosition?.();
    unbindPosition = bindFixedPopover(panelEl, {
      anchor: positioningAnchor,
      alignEnd: pickerAlignsToEnd(origin, isOwn),
      estimatedHeight: 460,
    });

    return () => {
      unbindPosition?.();
      unbindPosition = null;
    };
  });

  let recentEmojis = $state<string[]>([]);

  function handleEmojiClick(emoji: string) {
    if (
      !canAddDistinctReactionEmoji(
        existingReactionEmojis.map((e) => ({ emoji: e, userId: '_' })),
        emoji
      )
    ) {
      return;
    }
    onEmojiSelect?.(emoji);
    recentEmojis = persistRecentEmoji(emoji);
  }

  onMount(() => {
    recentEmojis = getRecentEmojis();
  });
</script>

<!--
  PORTALLED, FOR THE REASON `MessageMobileActions` IS, AND THE COORDINATES PROVE IT.

  This panel is `position: fixed` and it is rendered deep inside a `MessageBubble`, under
  `.page-scroll-wrap` - which carries `will-change: transform` for the swipe-between-tabs gesture.
  That makes the wrapper the CONTAINING BLOCK for every `fixed` descendant, so the coordinates
  `bindFixedPopover` computes against the viewport are then resolved against the wrapper instead.

  Measured on 2026-09-09, which is the only reason this is not still a guess: with the panel anchored
  correctly to the hover toolbar's icon strip, the action wrote `left: 958.8px` - the right answer,
  the strip's right edge minus the panel width - and the panel PAINTED at 1055. Ninety-six pixels of
  wrapper offset, silently added to a number that was already correct. The user's report was that the
  panel "n'est pas au meme endroit que le reste": the quick bar beside it is `absolute` and lands
  where it is put, while this one is `fixed` and does not.

  Moving the node to `document.body` is what makes `left` mean the viewport. Nothing else changes -
  the action, the anchor and the rung are the same.
-->
{#if origin}
  <div
    use:portal
    bind:this={panelEl}
    data-swipe-nav-ignore
    transition:scale={{ duration: 250, start: 0.95, opacity: 0, easing: (t) => t * (2 - t) }}
    class="bg-cn-surface fixed z-(--z-popover) flex w-[min(92vw,22rem)] origin-(--popover-origin) flex-col overflow-hidden rounded-2xl border border-black/5 shadow-2xl shadow-black/10 dark:border-white/10 dark:shadow-black/40"
    style:--popover-origin={isOwn ? 'top right' : 'top left'}
  >
    <!--
      NO TITLE ROW. A panel of emoji, opened from a reaction button, on a message: the user knows
      what they are doing, and the sentence saying it cost a line of vertical space on the screen
      that has the least of it (user, 2026-09-14: *"on peut enlever le texte 'Réagir au message' de
      partout, ca sert a rien, on le sait"*). The one message the panel still has to say - that this
      message cannot take another distinct reaction - is below, and it says something.
    -->
    {#if reactionsAtLimit}
      <p
        class="text-2xs border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-amber-700 dark:text-amber-400"
      >
        {m.msg_max_reactions_label({ max: MAX_DISTINCT_MESSAGE_REACTIONS })}
      </p>
    {/if}

    <!-- Section Émojis Récents -->
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
            onclick={() => handleEmojiClick(emoji)}
            class="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-lg shadow-sm transition-all hover:scale-110 hover:bg-black/10 hover:shadow-md dark:hover:bg-white/10"
            aria-label={m.msg_react_with_emoji({ emoji })}
          >
            <EmojiText text={emoji} />
          </button>
        {/each}
      </div>
    {/if}

    <EmojiGrid onPick={(emoji) => handleEmojiClick(emoji)} />
  </div>
{/if}
