<script lang="ts" generics="K extends string">
  /**
   * A FIXED tab set: 2 or 3 short labels, equal width, never scrolling. The app's rule (user,
   * 2026-10-08) is that a set this small must show EVERY entry at once - a scrolling strip hides
   * the ones past the edge - and that a bigger one becomes a hub (see section-navigation).
   *
   * Equal columns (`minmax(0, 1fr)`) with the icon above the label, which may wrap, so nothing is
   * clipped at 320 px whatever the translation. Full tablist semantics: roving tabindex, the arrow
   * keys / Home / End move AND select (automatic activation, as the panels load lazily on select).
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
    class?: string;
  }

  let {
    items,
    value,
    onSelect,
    label,
    tone = 'amber',
    idPrefix,
    class: extra = '',
  }: Props = $props();

  const ACTIVE = {
    amber: 'bg-amber-500/15 text-amber-700 shadow-sm dark:bg-amber-500/20 dark:text-amber-400',
    yellow: 'bg-cn-yellow text-cn-ink shadow-sm',
  } as const;
  const IDLE = 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5';

  let buttons: HTMLButtonElement[] = [];

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
    onSelect(items[next].key);
    buttons[next]?.focus();
  }
</script>

<div
  role="tablist"
  aria-label={label}
  data-segmented-control
  data-swipe-nav-ignore
  class="grid gap-1 rounded-xl bg-black/5 p-1 dark:bg-white/5 {extra}"
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
      class="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-center text-xs leading-tight font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 sm:flex-row sm:gap-2 sm:text-sm {selected
        ? ACTIVE[tone]
        : IDLE}"
    >
      {#if item.icon}
        {@const Icon = item.icon}
        <Icon size={16} />
      {/if}
      <span class="min-w-0 break-words">{item.label}</span>
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
