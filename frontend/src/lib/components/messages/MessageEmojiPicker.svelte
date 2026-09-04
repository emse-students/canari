<script lang="ts">
  import { FaceSlightlySmiling } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { scale } from 'svelte/transition';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import {
    MAX_DISTINCT_MESSAGE_REACTIONS,
    canAddDistinctReactionEmoji,
  } from '$lib/utils/chat/messageReactions';
  import 'emoji-picker-element';
  import enI18n from 'emoji-picker-element/i18n/en';

  interface Props {
    /** Whether the emoji picker panel is visible. */
    visible: boolean;
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
    visible = false,
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

  $effect(() => {
    if (!visible || !panelEl || !anchor) {
      unbindPosition?.();
      unbindPosition = null;
      return;
    }

    unbindPosition?.();
    unbindPosition = bindFixedPopover(panelEl, {
      anchor: () => anchor,
      alignEnd: isOwn,
      estimatedHeight: 460,
    });

    return () => {
      unbindPosition?.();
      unbindPosition = null;
    };
  });

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
    if (
      !canAddDistinctReactionEmoji(
        existingReactionEmojis.map((e) => ({ emoji: e, userId: '_' })),
        emoji
      )
    ) {
      return;
    }
    onEmojiSelect?.(emoji);
    persistRecentEmoji(emoji);
  }

  /**
   * The library's own English strings, used as the BASE both overrides are spread onto.
   *
   * THIS EXISTS BECAUSE ONE MISSING KEY CRASHED THE PICKER, in production, on every reaction.
   * `emoji-picker-element` runs `state.i18n.skinToneLabel.replace('{skinTone}', ...)` inside one of
   * its own effects, and our two hand-written objects defined thirteen of its fourteen keys -
   * `skinToneLabel` was the one nobody noticed. The effect also depends on `currentSkinTone`, which
   * is written asynchronously once the emoji database has loaded, so it did not throw at import
   * time: it threw when the picker was opened, as `TypeError: Cannot read properties of undefined
   * (reading 'replace')`, from inside the library where no stack frame named us.
   *
   * Adding the missing key would fix today and not tomorrow: the next version of the library that
   * adds a fifteenth key would break the same way. Spreading its defaults makes a missing key
   * IMPOSSIBLE rather than merely absent, which is the only version of this worth writing.
   */
  const EMOJI_PICKER_BASE_I18N = enI18n;

  /**
   * French UI strings for emoji-picker-element. The `locale` attribute alone does NOT
   * translate the interface (only the data-source provides localized search keywords),
   * so the `i18n` property must be set explicitly - otherwise the search box reads "Search".
   */
  const EMOJI_PICKER_FR_I18N = {
    ...EMOJI_PICKER_BASE_I18N,
    categoriesLabel: 'Catégories',
    emojiUnsupportedMessage: 'Votre navigateur ne supporte pas les emojis en couleur.',
    favoritesLabel: 'Favoris',
    loadingMessage: 'Chargement…',
    networkErrorMessage: 'Impossible de charger les emojis.',
    regionLabel: "Sélecteur d'emoji",
    searchDescription:
      'Quand des résultats sont disponibles, utilisez les flèches haut/bas et Entrée pour sélectionner.',
    searchLabel: 'Recherche',
    searchResultsLabel: 'Résultats de recherche',
    skinToneDescription:
      'Quand le sélecteur est ouvert, utilisez les flèches haut/bas et Entrée pour sélectionner.',
    skinTonesLabel: 'Tons de peau',
    skinTones: ['Défaut', 'Clair', 'Moyen-clair', 'Moyen', 'Moyen-foncé', 'Foncé'],
    categories: {
      custom: 'Personnalisé',
      'smileys-emotion': 'Smileys et émotions',
      'people-body': 'Personnes et corps',
      'animals-nature': 'Animaux et nature',
      'food-drink': 'Nourriture et boissons',
      'travel-places': 'Voyages et lieux',
      activities: 'Activités',
      objects: 'Objets',
      symbols: 'Symboles',
      flags: 'Drapeaux',
    },
  };

  const EMOJI_PICKER_EN_I18N = {
    ...EMOJI_PICKER_BASE_I18N,
    categoriesLabel: 'Categories',
    emojiUnsupportedMessage: 'Your browser does not support color emoji.',
    favoritesLabel: 'Favorites',
    loadingMessage: 'Loading…',
    networkErrorMessage: 'Could not load emoji.',
    regionLabel: 'Emoji picker',
    searchDescription:
      'When search results are available, press up or down to select and enter to choose.',
    searchLabel: 'Search',
    searchResultsLabel: 'Search results',
    skinToneDescription: 'When expanded, press up or down to select and enter to choose.',
    skinTonesLabel: 'Skin tones',
    skinTones: ['Default', 'Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'],
    categories: {
      custom: 'Custom',
      'smileys-emotion': 'Smileys & Emotion',
      'people-body': 'People & Body',
      'animals-nature': 'Animals & Nature',
      'food-drink': 'Food & Drink',
      'travel-places': 'Travel & Places',
      activities: 'Activities',
      objects: 'Objects',
      symbols: 'Symbols',
      flags: 'Flags',
    },
  };

  function attachEmojiPicker(node: HTMLElement) {
    // Set as a JS property (not an attribute) so the web component picks up the translations.
    const i18n = getLocale() === 'en' ? EMOJI_PICKER_EN_I18N : EMOJI_PICKER_FR_I18N;
    (node as unknown as { i18n: typeof EMOJI_PICKER_FR_I18N }).i18n = i18n;
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
    bind:this={panelEl}
    data-swipe-nav-ignore
    transition:scale={{ duration: 250, start: 0.95, opacity: 0, easing: (t) => t * (2 - t) }}
    class="fixed z-[200] flex w-[min(92vw,22rem)] origin-(--popover-origin) flex-col overflow-hidden rounded-[1.5rem] border border-black/5 bg-white/85 shadow-2xl shadow-black/10 backdrop-blur-2xl dark:border-white/10 dark:bg-black/60 dark:shadow-black/40"
    style:--popover-origin={isOwn ? 'top right' : 'top left'}
  >
    <!-- En-tête -->
    <div
      class="text-text-muted flex items-center gap-2 border-b border-black/5 bg-white/40 px-4 py-3 text-xs font-semibold dark:border-white/10 dark:bg-black/20"
    >
      <FaceSlightlySmiling size={14} class="text-amber-500" />
      {m.msg_react_to_message_label()}
    </div>
    {#if reactionsAtLimit}
      <p
        class="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[0.7rem] text-amber-700 dark:text-amber-400"
      >
        {m.msg_max_reactions_label({ max: MAX_DISTINCT_MESSAGE_REACTIONS })}
      </p>
    {/if}

    <!-- Section Émojis Récents -->
    {#if recentEmojis.length > 0}
      <div
        class="flex flex-wrap items-center gap-1.5 border-b border-black/5 bg-white/20 px-3 py-2 dark:border-white/10 dark:bg-black/10"
      >
        <span class="text-text-muted/80 mr-2 text-[0.65rem] font-bold tracking-widest uppercase">
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
    <!-- data-source pointe vers le dataset emojibase FRANÇAIS auto-hébergé : `locale="fr"`
         ne traduit que l'UI, les mots-clés de recherche viennent du data-source. Sans lui,
         la recherche ne fonctionnait qu'en anglais ("wing" au lieu de "aile"). -->
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
      use:attachEmojiPicker
      class="min-h-0 w-full flex-auto"
      locale={getLocale() === 'en' ? 'en' : 'fr'}
      data-source={getLocale() === 'en' ? undefined : '/emoji-data-fr.json'}
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
