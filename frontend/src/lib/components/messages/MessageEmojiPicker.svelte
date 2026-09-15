<script lang="ts">
  import { onMount } from 'svelte';
  import { scale } from 'svelte/transition';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import {
    MAX_DISTINCT_MESSAGE_REACTIONS,
    canAddDistinctReactionEmoji,
  } from '$lib/utils/chat/messageReactions';
  import {
    pickerAlignsToEnd,
    pickerAnchor,
    type MessagePickerOrigin,
  } from '$lib/utils/chat/reactionPicker';
  import {
    attachEmojiPicker,
    emojiPickerDataSource,
    getRecentEmojis,
    persistRecentEmoji,
  } from './emojiPickerShared';
  import 'emoji-picker-element';

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
            {emoji}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Composant Web emoji-picker -->
    <!-- data-source pointe vers un dataset emojibase AUTO-HÉBERGÉ, dans les DEUX langues :
         `locale` ne traduit que l'UI, les mots-clés de recherche viennent du data-source. Sans lui,
         la recherche ne fonctionnait qu'en anglais ("wing" au lieu de "aile").

         ET IL N'EST JAMAIS `undefined`. C'ÉTAIT UN APPEL SORTANT VERS UN CDN TIERS. Sans attribut,
         emoji-picker-element va chercher ses données sur
         `cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json` : l'IP de chaque
         membre part chez un tiers dès l'ouverture du sélecteur, le sélecteur ne peut pas s'ouvrir
         hors ligne - donc pas du tout dans les applications mobiles - et `@^1` ne fixe rien, donc
         l'ensemble des emojis proposés pouvait changer sans commit. Les deux fichiers sont copiés
         d'un paquet épinglé à une version EXACTE par `tools/emoji-data/sync.mjs` et vérifiés par
         `emojiData.test.ts`. -->
    <!--
      `flex-auto`, AND NOT `flex-1`, AND THAT ONE WORD IS WHY THE LIST WOULD NOT SCROLL.
      Measured on the running app 2026-09-04, at every panel size: `section.picker` inside the
      element's shadow root was **1017 px tall inside a 417 px host**, so its `.tabpanel` was
      content-sized (880 of 880), `scrollHeight === clientHeight`, nothing to scroll - and everything
      past the host's height was clipped away by this panel's `overflow-hidden`. Not an edge case:
      every open, at 460 px, at 300 px and at 200 px of panel alike.
      THE CAUSE IS THE FLEX BASIS. `flex-1` is `flex: 1 1 0%`, so the host's main size is GROWN from
      zero rather than resolved from a length, and the library sizes `section.picker` against the
      host's own `height: 400px` (its `:host` rule) - which a zero basis has thrown away.
      `flex: 1 1 auto` keeps that 400 px as the basis, so the section tracks the host exactly, and it
      keeps tracking it when the flex algorithm SHRINKS it - measured at 400/400, 257/257, 157/157
      and 97/97, scrolling in all four. That last property is the one that matters: a fix that only
      worked in the roomy case would leave the cramped one broken, and cramped is where a user meets
      it, near a viewport edge.
      AND THE INLINE `height:` IS GONE. It was a hard-coded guess at the height of everything above
      (`- 3rem`, or `- 5.5rem` with recents) and it was wrong three ways: the recents row wraps to two
      lines well before twelve buttons, the reactions-at-limit banner is not in the guess at all, and
      **deleting it alone does not fix the scroll** - measured: with `flex-1` kept, the section was
      still 973 px inside 417. The layout knows the answer; a second constant would be wrong the next
      time this header gains a line.
    -->
    <emoji-picker
      use:attachEmojiPicker={handleEmojiClick}
      class="min-h-0 w-full flex-auto"
      style:--emoji-font-family="'Noto Color Emoji Canari'"
      locale={getLocale() === 'en' ? 'en' : 'fr'}
      data-source={emojiPickerDataSource()}
    ></emoji-picker>
  </div>
{/if}

<style>
  /* Stylisation globale du composant emoji-picker-element pour qu'il se fonde
    dans notre design Glassmorphism sans casser ses bordures.
  */
  emoji-picker {
    --background: transparent;
    --border-color: transparent;
    --input-border-radius: 1rem;
    --input-padding: 0.5rem 1rem;
    --indicator-color: #f59e0b; /* Couleur Amber-500 de Tailwind */
    --category-emoji-size: 1.1rem;
    --emoji-size: 1.5rem;
    --input-font-size: 0.875rem;
    --num-columns: 8;
  }

  /* Adaptation parfaite au mode sombre */
  :global(:root[data-theme='dark']) emoji-picker {
    --button-hover-background: rgba(255, 255, 255, 0.1);
    --button-active-background: rgba(255, 255, 255, 0.2);
    --search-background: rgba(0, 0, 0, 0.4);
    --search-focus-background: rgba(0, 0, 0, 0.6);
    --search-icon-color: rgba(255, 255, 255, 0.5);
    --text-color: rgba(255, 255, 255, 0.9);
    --category-button-color: rgba(255, 255, 255, 0.5);
    --category-button-active-color: #f59e0b;
  }
</style>
