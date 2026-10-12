<script module lang="ts">
  /** The three directories the associations area is made of. */
  export type AssociationsSection = 'associations' | 'lists' | 'institutions';
</script>

<script lang="ts">
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Plus } from '@lucide/svelte';

  interface Props {
    /** The directory this page IS: its nav button is drawn active and its creation is offered. */
    section: AssociationsSection;
    title: string;
    subtitle: string;
    /** Whether the reader may create what THIS directory lists (the rights differ per type). */
    canCreate: boolean;
  }

  let { section, title, subtitle, canCreate }: Props = $props();

  /** Where each directory creates its own kind, and the label of that one primary action. */
  const creation = $derived(
    {
      associations: { href: '/associations/new', label: m.assoc_new_create_btn() },
      lists: { href: '/lists/new', label: m.list_new_create_btn() },
      institutions: { href: '/institutions/new', label: m.inst_new_create_btn() },
    }[section]
  );

  /** Navigation only: the three directories and the global agenda. Creation is NOT in this set. */
  const navItems = $derived([
    { key: 'associations', href: '/associations', label: m.assoc_list_heading() },
    { key: 'lists', href: '/lists', label: m.assoc_list_lists_btn() },
    { key: 'institutions', href: '/institutions', label: m.assoc_list_institutions_btn() },
    { key: 'calendar', href: '/calendar', label: m.assoc_list_global_calendar() },
  ]);
</script>

<!--
  ONE HEADER FOR THE THREE DIRECTORIES (user, 2026-10-07: four buttons of two kinds read as one
  undifferentiated set, and the institutions page had no creation at all).

  Two kinds of control, drawn as two kinds: NAVIGATION is a row of outlined pills under the title
  with the current directory filled (`aria-current`), and the single PRIMARY action - creation, in
  yellow - sits on the title's own line. The creation follows the page: the same place, the same
  look, a label naming what THAT directory creates.
-->
<PageHeader {title} {subtitle}>
  {#snippet actions()}
    {#if canCreate}
      <a
        href={creation.href}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-sm transition-all"
      >
        <Plus size={16} />
        {creation.label}
      </a>
    {/if}
  {/snippet}
  <nav aria-label={m.assoc_nav_aria()} class="flex flex-wrap items-center gap-1.5 sm:gap-2">
    {#each navItems as item (item.key)}
      {@const active = item.key === section}
      <a
        href={item.href}
        aria-current={active ? 'page' : undefined}
        class="inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors sm:px-4 {active
          ? 'border-cn-yellow bg-cn-yellow/15 text-text-main'
          : 'border-cn-border text-text-muted hover:text-text-main hover:bg-(--cn-surface)'}"
      >
        {item.label}
      </a>
    {/each}
  </nav>
</PageHeader>
