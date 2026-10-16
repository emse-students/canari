<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { HubRow } from './breadcrumb';

  interface Props {
    rows: HubRow[];
    /** Names the list for assistive technology (Paraglide, from the caller). */
    label: string;
  }

  let { rows, label }: Props = $props();
</script>

<!--
  THE HUB: sections as rows, the way Android's Settings lists them (user, 2026-10-08: "on navigue
  en profondeur"). A row is a real link, so Back, reload and sharing all behave. There is no strip
  here, hence no `data-swipe-nav-ignore`: nothing scrolls sideways that the tab swipe could steal.
  The one exception is an ACTION row (`onSelect`, the dashboard's sign-out): a button, same look.
-->
<ul
  aria-label={label}
  class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border shadow-sm"
>
  {#each rows as row (row.key)}
    <li>
      {#if row.onSelect}
        <button
          type="button"
          data-hub-row={row.key}
          onclick={row.onSelect}
          class="hover:bg-cn-bg flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors {row.tone ===
          'danger'
            ? 'text-red-err'
            : 'text-text-main'}"
        >
          {@render content(row)}
        </button>
      {:else}
        <a
          href={row.href}
          data-hub-row={row.key}
          class="hover:bg-cn-bg flex items-center gap-3 px-4 py-3.5 transition-colors {row.tone ===
          'danger'
            ? 'text-red-err'
            : 'text-text-main'}"
        >
          {@render content(row)}
          <ChevronRight size={18} class="text-text-muted shrink-0" />
        </a>
      {/if}
    </li>
  {/each}
</ul>

{#snippet content(row: HubRow)}
  {@const Icon = row.icon}
  {#if row.avatarUserId}
    <Avatar userId={row.avatarUserId} size="sm" />
  {:else}
    <Icon size={20} />
  {/if}
  <!-- A label WRAPS and a summary keeps two lines: at 200 % text a 390 px row cut a person's name
       to "Ada Lov..." when both were `truncate` (2026-10-16). -->
  <span class="min-w-0 flex-1">
    <span class="block text-sm font-bold hyphens-auto">{row.label}</span>
    {#if row.summary}
      <span class="text-text-muted line-clamp-2 text-xs">{row.summary}</span>
    {/if}
  </span>
  {#if row.badge && row.badge > 0}
    <!-- The sidebar's count pill: the same number, the same look, in a row. -->
    <span
      data-hub-badge
      aria-label={row.badgeLabel}
      class="text-2xs inline-flex shrink-0 items-center justify-center rounded-full bg-red-500 px-2 py-0.5 leading-none font-bold text-white"
    >
      {row.badge > 99 ? '99+' : row.badge}
    </span>
  {/if}
{/snippet}
