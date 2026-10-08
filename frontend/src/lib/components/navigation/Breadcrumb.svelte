<script lang="ts">
  import { ArrowLeft, ChevronRight } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { foldedCrumbCount, previousCrumb, type Crumb } from './breadcrumb';

  interface Props {
    /** The whole path, root first; the LAST is the current page. Every crumb is a link. */
    crumbs: Crumb[];
  }

  let { crumbs }: Props = $props();

  let previous = $derived(previousCrumb(crumbs));
  let folded = $derived(foldedCrumbCount(crumbs.length));
</script>

<!--
  THE PATH (user, 2026-10-08: "Associations > BDE > Partenariats"). The arrow goes up ONE level -
  the previous crumb - and every crumb is a link, the last one being the page you are on. On a
  phone the middle of a long path folds behind an ellipsis rather than wrapping or scrolling; the
  arrow still reaches the level above, and a wide screen shows the whole path.
-->
<nav aria-label={m.nav_breadcrumb_label()} class="mb-1 flex items-center gap-2" data-breadcrumb>
  {#if previous}
    <a
      href={previous.href}
      aria-label={m.common_back_to({ label: previous.label })}
      data-breadcrumb-back
      class="text-text-muted hover:text-text-main -ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
    >
      <ArrowLeft size={18} />
    </a>
  {/if}
  <ol class="text-text-muted flex min-w-0 flex-1 items-center gap-1 text-sm">
    {#each crumbs as crumb, i (i)}
      {@const last = i === crumbs.length - 1}
      {@const foldedOnPhone = i >= 1 && i <= folded}
      {#if i === 1 && folded > 0}
        <li aria-hidden="true" class="flex shrink-0 items-center gap-1 sm:hidden">
          <ChevronRight size={14} class="shrink-0" />
          <span>...</span>
        </li>
      {/if}
      <li
        class="min-w-0 items-center gap-1 {foldedOnPhone ? 'hidden sm:flex' : 'flex'} {last
          ? 'text-text-main font-semibold'
          : 'shrink'}"
      >
        {#if i > 0}
          <ChevronRight size={14} class="shrink-0" />
        {/if}
        <a
          href={crumb.href}
          aria-current={last ? 'page' : undefined}
          class="hover:text-text-main block truncate transition-colors">{crumb.label}</a
        >
      </li>
    {/each}
  </ol>
</nav>
