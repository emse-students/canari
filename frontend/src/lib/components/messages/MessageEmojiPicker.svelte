<script lang="ts">
  import { Smile } from '@lucide/svelte';
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
   * French UI strings for emoji-picker-element. The `locale` attribute alone does NOT
   * translate the interface (only the data-source provides localized search keywords),
   * so the `i18n` property must be set explicitly - otherwise the search box reads "Search".
   */
  const EMOJI_PICKER_FR_I18N = {
    categoriesLabel: 'Catégories',
    emojiUnsupportedMessage: "Votre navigateur ne supporte pas les emojis en couleur.",
    favoritesLabel: 'Favoris',
    loadingMessage: 'Chargement…',
    networkErrorMessage: 'Impossible de charger les emojis.',
    regionLabel: "Sélecteur d'emoji",
    searchDescription: "Quand des résultats sont disponibles, utilisez les flèches haut/bas et Entrée pour sélectionner.",
    searchLabel: 'Recherche',
    searchResultsLabel: 'Résultats de recherche',
    skinToneDescription: "Quand le sélecteur est ouvert, utilisez les flèches haut/bas et Entrée pour sélectionner.",
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
    categoriesLabel: 'Categories',
    emojiUnsupportedMessage: 'Your browser does not support color emoji.',
    favoritesLabel: 'Favorites',
    loadingMessage: 'Loading…',
    networkErrorMessage: 'Could not load emoji.',
    regionLabel: 'Emoji picker',
    searchDescription: 'When search results are available, press up or down to select and enter to choose.',
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
    class="fixed z-[200] w-[min(92vw,22rem)] bg-white/85 dark:bg-black/60 backdrop-blur-2xl border border-black/5 dark:border-white/10 rounded-[1.5rem] shadow-2xl shadow-black/10 dark:shadow-black/40 overflow-hidden flex flex-col origin-[var(--popover-origin)]"
    style:--popover-origin={isOwn ? 'top right' : 'top left'}
  >
    <!-- En-tête -->
    <div
      class="px-4 py-3 border-b border-black/5 dark:border-white/10 text-xs font-semibold text-text-muted flex items-center gap-2 bg-white/40 dark:bg-black/20"
    >
      <Smile size={14} class="text-amber-500" /> {m.msg_react_to_message_label()}
    </div>
    {#if reactionsAtLimit}
      <p class="px-4 py-2 text-[0.7rem] text-amber-700 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
        {m.msg_max_reactions_label({ max: MAX_DISTINCT_MESSAGE_REACTIONS })}
      </p>
    {/if}

    <!-- Section Émojis Récents -->
    {#if recentEmojis.length > 0}
      <div
        class="px-3 py-2 border-b border-black/5 dark:border-white/10 flex items-center gap-1.5 flex-wrap bg-white/20 dark:bg-black/10"
      >
        <span class="text-[0.65rem] font-bold uppercase tracking-widest text-text-muted/80 mr-2">
          {m.msg_recent_reactions_label()}
        </span>
        {#each recentEmojis as emoji (emoji)}
          <button
            type="button"
            onclick={() => handleEmojiClick(emoji)}
            class="w-8 h-8 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 hover:scale-110 transition-all text-lg inline-flex items-center justify-center shadow-sm hover:shadow-md cursor-pointer"
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
    <emoji-picker
      use:attachEmojiPicker
      class="w-full min-h-0 flex-1"
      style="height: min(22rem, calc(var(--popover-max-h, 22rem) - {recentEmojis.length > 0
        ? '5.5rem'
        : '3rem'}));"
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
