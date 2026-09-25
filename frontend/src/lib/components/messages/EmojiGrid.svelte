<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { emojiSvgSrc } from '$lib/utils/emojiSvg';
  import {
    EMOJI_CATEGORIES,
    SKIN_TONES,
    loadEmojiCatalog,
    withSkinTone,
    type EmojiCategory,
    type EmojiEntry,
    type SkinTone,
  } from '$lib/utils/emojiCatalog';
  import { rankByTokens } from '$lib/utils/tolerantSearch';
  import {
    emojiPickerDataSource,
    getPreferredSkinTone,
    persistPreferredSkinTone,
  } from './emojiPickerShared';

  /**
   * THE EMOJI PICKER'S BODY, DRAWN BY US, IN NOTO'S PICTURES (2026-09-25).
   *
   * It replaced `emoji-picker-element`, which draws with a font inside its shadow root - so the
   * picker kept showing Apple's glyphs on WebKit after every message had moved to Noto's pictures.
   * Both mounts use it: the reaction picker and the composer's. It does what the library did for us
   * and nothing more - categories, search, one skin tone - on the same self-hosted dataset
   * (`emojiCatalog.ts`); the recents row stays with each mount, which already owned it.
   *
   * Search follows the ecosystem's contract (`tolerantSearch.ts`): accents and case folded, every
   * word must match, closest first, one typo forgiven from four letters.
   */
  interface Props {
    /** Called with the picked emoji (skin tone applied) and whether Shift was held. */
    onPick: (emoji: string, shiftKey: boolean) => void;
  }

  let { onPick }: Props = $props();

  const CATEGORY_LABELS: Record<EmojiCategory, () => string> = {
    'smileys-emotion': m.emoji_picker_category_smileys_emotion,
    'people-body': m.emoji_picker_category_people_body,
    'animals-nature': m.emoji_picker_category_animals_nature,
    'food-drink': m.emoji_picker_category_food_drink,
    'travel-places': m.emoji_picker_category_travel_places,
    activities: m.emoji_picker_category_activities,
    objects: m.emoji_picker_category_objects,
    symbols: m.emoji_picker_category_symbols,
    flags: m.emoji_picker_category_flags,
  };
  const SKIN_TONE_LABELS: Record<SkinTone, () => string> = {
    0: m.emoji_picker_skin_tone_default,
    1: m.emoji_picker_skin_tone_light,
    2: m.emoji_picker_skin_tone_medium_light,
    3: m.emoji_picker_skin_tone_medium,
    4: m.emoji_picker_skin_tone_medium_dark,
    5: m.emoji_picker_skin_tone_dark,
  };
  /** The swatch shown on the tone button: a raised hand takes every tone. */
  const TONE_SWATCH = '✋';

  let entries = $state<EmojiEntry[] | null>(null);
  let failed = $state(false);
  let query = $state('');
  let tone = $state<SkinTone>(getPreferredSkinTone());
  let choosingTone = $state(false);
  let activeCategory = $state<EmojiCategory>(EMOJI_CATEGORIES[0]);
  let scroller = $state<HTMLElement | null>(null);

  const sections = $derived(
    entries === null
      ? []
      : EMOJI_CATEGORIES.map((category) => ({
          category,
          entries: entries!.filter((entry) => entry.category === category),
        })).filter((section) => section.entries.length > 0)
  );
  const results = $derived(
    entries === null || !query.trim() ? null : rankByTokens(entries, query, (entry) => entry.words)
  );

  async function load() {
    failed = false;
    try {
      entries = await loadEmojiCatalog(emojiPickerDataSource());
    } catch (e) {
      console.warn('[EMOJI] catalogue failed to load', e);
      failed = true;
    }
  }

  onMount(() => {
    void load();
  });

  function pick(entry: EmojiEntry, event: MouseEvent) {
    onPick(withSkinTone(entry, tone), event.shiftKey);
  }

  function chooseTone(next: SkinTone) {
    tone = next;
    choosingTone = false;
    persistPreferredSkinTone(next);
  }

  async function jumpTo(category: EmojiCategory) {
    query = '';
    await tick();
    scroller?.querySelector(`[data-category="${category}"]`)?.scrollIntoView({ block: 'start' });
    activeCategory = category;
  }

  /** The category whose section holds the top of the scroll area - what the tab bar highlights. */
  function trackActiveCategory() {
    if (!scroller || results) return;
    const top = scroller.getBoundingClientRect().top + 4;
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-category]')) {
      if (el.getBoundingClientRect().top <= top) {
        activeCategory = el.dataset.category as EmojiCategory;
      }
    }
  }
</script>

{#snippet emojiButton(entry: EmojiEntry)}
  {@const emoji = withSkinTone(entry, tone)}
  <button
    type="button"
    onclick={(event) => pick(entry, event)}
    class="flex aspect-square items-center justify-center rounded-lg transition-transform hover:scale-110 hover:bg-black/5 active:scale-95 dark:hover:bg-white/10"
    aria-label={entry.annotation}
    title={entry.annotation}
  >
    <img
      class="size-7"
      src={emojiSvgSrc(emoji) ?? emojiSvgSrc(entry.emoji)}
      alt={emoji}
      loading="lazy"
      decoding="async"
      draggable="false"
    />
  </button>
{/snippet}

<div class="flex min-h-0 flex-col" role="region" aria-label={m.emoji_picker_region_label()}>
  <div class="flex items-center gap-2 px-3 pt-3 pb-2">
    <input
      type="search"
      bind:value={query}
      placeholder={m.emoji_picker_search_label()}
      aria-label={m.emoji_picker_search_label()}
      class="bg-cn-bg text-text-main placeholder:text-text-muted min-w-0 flex-1 rounded-2xl border border-black/5 px-4 py-2 text-sm outline-none focus:border-amber-500/60 dark:border-white/10"
    />
    <button
      type="button"
      onclick={() => (choosingTone = !choosingTone)}
      class="flex size-9 shrink-0 items-center justify-center rounded-xl text-xl hover:bg-black/5 dark:hover:bg-white/10"
      aria-label={m.emoji_picker_skin_tones_label()}
      aria-expanded={choosingTone}
      title={SKIN_TONE_LABELS[tone]()}
    >
      <EmojiText
        text={tone === 0 ? TONE_SWATCH : `${TONE_SWATCH}${String.fromCodePoint(0x1f3fa + tone)}`}
      />
    </button>
  </div>

  {#if choosingTone}
    <div
      class="flex items-center justify-end gap-1 px-3 pb-2"
      role="listbox"
      aria-label={m.emoji_picker_skin_tones_label()}
    >
      {#each SKIN_TONES as option (option)}
        <button
          type="button"
          role="option"
          aria-selected={option === tone}
          onclick={() => chooseTone(option)}
          class="flex size-9 items-center justify-center rounded-xl text-xl hover:bg-black/5 dark:hover:bg-white/10 {option ===
          tone
            ? 'bg-amber-500/15'
            : ''}"
          aria-label={SKIN_TONE_LABELS[option]()}
          title={SKIN_TONE_LABELS[option]()}
        >
          <EmojiText
            text={option === 0
              ? TONE_SWATCH
              : `${TONE_SWATCH}${String.fromCodePoint(0x1f3fa + option)}`}
          />
        </button>
      {/each}
    </div>
  {/if}

  {#if sections.length > 0 && !results}
    <div
      class="flex items-center justify-between border-b border-black/5 px-2 pb-1 dark:border-white/10"
      role="tablist"
      aria-label={m.emoji_picker_categories_label()}
    >
      {#each sections as section (section.category)}
        <button
          type="button"
          role="tab"
          aria-selected={section.category === activeCategory}
          onclick={() => jumpTo(section.category)}
          class="flex size-8 items-center justify-center rounded-lg border-b-2 text-lg transition-opacity {section.category ===
          activeCategory
            ? 'border-amber-500 opacity-100'
            : 'border-transparent opacity-60 hover:opacity-100'}"
          aria-label={CATEGORY_LABELS[section.category]()}
          title={CATEGORY_LABELS[section.category]()}
        >
          <EmojiText text={section.entries[0].emoji} />
        </button>
      {/each}
    </div>
  {/if}

  <div bind:this={scroller} onscroll={trackActiveCategory} class="h-72 overflow-y-auto px-2 pb-2">
    {#if failed}
      <div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p class="text-text-muted text-sm">{m.emoji_picker_network_error_message()}</p>
        <button
          type="button"
          onclick={load}
          class="rounded-lg bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-700 dark:text-amber-400"
        >
          {m.emoji_picker_retry()}
        </button>
      </div>
    {:else if entries === null}
      <p class="text-text-muted p-4 text-center text-sm">{m.emoji_picker_loading_message()}</p>
    {:else if results}
      {#if results.length === 0}
        <p class="text-text-muted p-4 text-center text-sm">{m.emoji_picker_no_results()}</p>
      {:else}
        <h3 class="text-text-muted text-2xs px-1 pt-2 pb-1 font-bold tracking-widest uppercase">
          {m.emoji_picker_search_results_label()}
        </h3>
        <div class="grid grid-cols-8 gap-0.5">
          {#each results as entry (entry.emoji)}
            {@render emojiButton(entry)}
          {/each}
        </div>
      {/if}
    {:else}
      {#each sections as section (section.category)}
        <section data-category={section.category}>
          <h3
            class="bg-cn-surface text-text-muted text-2xs sticky top-0 z-10 px-1 pt-2 pb-1 font-bold tracking-widest uppercase"
          >
            {CATEGORY_LABELS[section.category]()}
          </h3>
          <div class="grid grid-cols-8 gap-0.5">
            {#each section.entries as entry (entry.emoji)}
              {@render emojiButton(entry)}
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>
