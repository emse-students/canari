<script lang="ts" generics="K extends string">
  /**
   * A FIXED tab set: 2 or 3 short labels, equal width, never scrolling. The app's rule (user,
   * 2026-10-08) is that a set this small must show EVERY entry at once - a scrolling strip hides
   * the ones past the edge - and that a bigger one becomes a hub (see section-navigation).
   *
   * Equal columns (`minmax(0, 1fr)`) with the icon above the label, which may wrap, so nothing is
   * clipped at 320 px whatever the translation. Full tablist semantics: roving tabindex, the arrow
   * keys / Home / End move AND select by default (automatic activation, as the panels load lazily on
   * select); `activation="manual"` moves focus only and Enter/Space selects.
   */
  import type { Component } from 'svelte';

  interface Item {
    key: K;
    label: string;
    icon?: Component<{ size?: number }>;
    /** A count drawn after the label; hidden at 0 or absent. */
    badge?: number;
    /** Classes for the badge pill, when it must differ from the neutral default. */
    badgeClass?: string;
  }

  interface Props {
    items: Item[];
    value: K;
    onSelect: (key: K) => void;
    /** Names the tablist for a screen reader. */
    label: string;
    /** `amber` is the panels' accent, `yellow` the brand pill of the admin pages and media panel. */
    tone?: 'amber' | 'yellow';
    /** When set, tabs get `${idPrefix}tab-<key>` ids and `aria-controls` `${idPrefix}tabpanel-<key>`. */
    idPrefix?: string;
    /**
     * `pill` (default): the filled track with a raised active tab. `underline`: bare tabs on a
     * rule, the active one marked by a brand underline (the bookings dashboard's phone tabs).
     * `overlay`: no track, white text with a shadow ON a video (the CanaReels order switch, as
     * TikTok and Instagram draw theirs) - the selected tab full white, medium weight and a short
     * underline, the other dimmed.
     */
    variant?: 'pill' | 'underline' | 'overlay';
    /**
     * `auto` (default): arrows move AND select, for panels that load lazily on select. `manual`:
     * arrows only move focus, Enter/Space selects - for a choice whose selection is a committed
     * write (a confirmation dialog must not open on an arrow keypress).
     */
    activation?: 'auto' | 'manual';
    class?: string;
  }

  let {
    items,
    value,
    onSelect,
    label,
    tone = 'amber',
    idPrefix,
    variant = 'pill',
    activation = 'auto',
    class: extra = '',
  }: Props = $props();

  const ACTIVE = {
    amber: 'bg-accent/15 text-accent-text shadow-sm',
    yellow: 'bg-accent text-on-accent shadow-sm',
  } as const;
  const IDLE = 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5';

  // `$state`, so `bind:this={buttons[i]}` binds to a reactive slot: a plain array drew Svelte's
  // `binding_property_non_reactive` warning on every mount of the feed.
  let buttons = $state<HTMLButtonElement[]>([]);

  /** Arrow keys wrap around; Home/End jump. The newly selected tab takes focus. */
  function onKeydown(event: KeyboardEvent, index: number) {
    const last = items.length - 1;
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = index === last ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = index === 0 ? last : index - 1;
    } else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next < 0) return;
    event.preventDefault();
    if (activation === 'auto') onSelect(items[next].key);
    buttons[next]?.focus();
  }
</script>

<div
  role="tablist"
  aria-label={label}
  data-segmented-control
  data-swipe-nav-ignore
  data-variant={variant}
  class="grid gap-1 {variant === 'underline'
    ? 'border-cn-border border-b'
    : variant === 'overlay'
      ? ''
      : 'rounded-xl bg-black/5 p-1 dark:bg-white/5'} {extra}"
  style:grid-template-columns="repeat({items.length}, minmax(0, 1fr))"
>
  {#each items as item, i (item.key)}
    {@const selected = item.key === value}
    <button
      bind:this={buttons[i]}
      type="button"
      role="tab"
      id={idPrefix === undefined ? undefined : `${idPrefix}tab-${item.key}`}
      aria-controls={idPrefix === undefined ? undefined : `${idPrefix}tabpanel-${item.key}`}
      aria-selected={selected}
      tabindex={selected ? 0 : -1}
      onclick={() => onSelect(item.key)}
      onkeydown={(e) => onKeydown(e, i)}
      class="focus-visible:ring-accent-icon flex min-w-0 items-center justify-center text-center leading-tight transition-colors outline-none focus-visible:ring-2 {variant ===
      'underline'
        ? `-mb-px min-h-11 gap-2 border-b-2 px-4 text-sm font-semibold ${selected ? 'border-accent-icon text-text-main' : 'text-text-muted hover:text-text-main border-transparent'}`
        : variant === 'overlay'
          ? `min-h-11 gap-2 rounded-lg px-3 text-sm [text-shadow:0_1px_3px_rgb(0_0_0/0.6)] ${selected ? 'font-medium text-white' : 'font-normal text-white/60 hover:text-white/80'}`
          : `flex-col gap-1 rounded-lg px-1 py-2 text-xs font-semibold sm:flex-row sm:gap-2 sm:text-sm ${selected ? ACTIVE[tone] : IDLE}`}"
    >
      {#if item.icon}
        {@const Icon = item.icon}
        <Icon size={16} />
      {/if}
      {#if variant === 'overlay'}
        <span
          class="relative min-w-0 break-words after:absolute after:inset-x-1/4 after:-bottom-1 after:h-0.5 after:rounded-full {selected
            ? 'after:bg-white'
            : 'after:bg-transparent'}">{item.label}</span
        >
      {:else}
        <span class="min-w-0 break-words">{item.label}</span>
      {/if}
      {#if item.badge && item.badge > 0}
        <span
          class="text-2xs rounded-full px-1.5 py-0.5 font-bold {item.badgeClass ??
            'bg-black/10 dark:bg-white/15'}"
        >
          {item.badge}
        </span>
      {/if}
    </button>
  {/each}
</div>
