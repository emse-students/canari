<script lang="ts">
  import { Check } from '@lucide/svelte';
  import type { MenuListSection } from './menuList';
  import { Log } from '$lib/utils/Log';

  /**
   * A MENU AS A LIST OF TITLED SECTIONS: the icon on the left, the label left-aligned beside it,
   * an optional muted line under the label, never a centred tile.
   *
   * Asked by the owner on 2026-11-07 about the form editor's menus, whose type picker was a grid of
   * centred tiles: a label that wrapped onto two lines no longer lined up with its icon, and the
   * ten types read as one undifferentiated block. Every menu of the form editor - the add wizard's
   * first step, a question's type menu, its "..." menu - draws this one list, so they cannot drift
   * apart again. Up and Down move between the entries, Home and End jump to the ends.
   */
  interface Props {
    sections: MenuListSection[];
    onSelect: (key: string) => void;
    /** Names the whole list for assistive technology. */
    label: string;
  }

  let { sections, onSelect, label }: Props = $props();

  let listEl = $state<HTMLElement | null>(null);
  const domKey = crypto.randomUUID();

  function entries(): HTMLButtonElement[] {
    return Array.from(listEl?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []);
  }

  function onKeydown(e: KeyboardEvent) {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(all.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = at < 0 ? all.length - 1 : Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next < 0) return;
    e.preventDefault();
    all[next]?.focus();
  }

  function select(key: string) {
    Log.d('MenuList', `"${label}" -> ${key}`);
    onSelect(key);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={listEl}
  class="flex flex-col"
  role="group"
  aria-label={label}
  onkeydown={onKeydown}
  data-testid="menu-list"
>
  {#each sections as section, si (si)}
    <div
      role="group"
      aria-labelledby={section.title ? `menu-${domKey}-${si}` : undefined}
      class={si > 0 && !section.title ? 'border-cn-border mt-1 border-t pt-1' : ''}
      data-menu-section={si}
    >
      {#if section.title}
        <p
          id="menu-{domKey}-{si}"
          class="text-text-muted text-2xs px-3 pt-3 pb-1 font-bold"
          data-menu-section-title
        >
          {section.title}
        </p>
      {/if}
      {#each section.items as item (item.key)}
        {@const Icon = item.Icon}
        <button
          type="button"
          data-menu-item={item.key}
          aria-current={item.selected ? 'true' : undefined}
          onclick={() => select(item.key)}
          class="focus-visible:ring-accent/60 flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 {item.selected
            ? 'bg-accent/15'
            : 'hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          {#if Icon}
            <Icon
              size={18}
              aria-hidden="true"
              class="shrink-0 {item.danger
                ? 'text-red-err'
                : item.selected
                  ? 'text-cn-dark'
                  : 'text-text-muted'}"
            />
          {/if}
          <span class="flex min-w-0 flex-1 flex-col">
            <span
              class="text-sm font-semibold {item.danger ? 'text-red-err' : 'text-text-main'}"
              data-menu-item-label>{item.label}</span
            >
            {#if item.description}
              <span class="text-text-muted text-xs">{item.description}</span>
            {/if}
          </span>
          {#if item.selected}
            <Check size={16} aria-hidden="true" class="text-cn-dark shrink-0" />
          {/if}
        </button>
      {/each}
    </div>
  {/each}
</div>
