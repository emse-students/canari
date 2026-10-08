<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
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
-->
<ul
  aria-label={label}
  class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border shadow-sm"
>
  {#each rows as row (row.key)}
    {@const Icon = row.icon}
    <li>
      <a
        href={row.href}
        data-hub-row={row.key}
        class="hover:bg-cn-bg flex items-center gap-3 px-4 py-3.5 transition-colors {row.tone ===
        'danger'
          ? 'text-red-err'
          : 'text-text-main'}"
      >
        <Icon size={20} />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-bold">{row.label}</span>
          {#if row.summary}
            <span class="text-text-muted block truncate text-xs">{row.summary}</span>
          {/if}
        </span>
        <ChevronRight size={18} class="text-text-muted shrink-0" />
      </a>
    </li>
  {/each}
</ul>
