<script lang="ts">
  import { ArrowLeft } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    /** The page title. Already localized by the caller. */
    title: string;
    /**
     * A route this page is a sub-page OF, drawn as a back link above the title.
     *
     * ONLY FOR A PAGE ONE ACTUALLY ARRIVES AT FROM THERE. The agenda carried a back link to
     * `/associations` while being a top-level destination in the navigation, so following it sent
     * the reader somewhere they had never been; it was deleted rather than moved here.
     */
    backHref?: string;
    /** The label for `backHref`. Required with it. */
    backLabel?: string;
    /** One line under the title. Omit for a page whose title says everything. */
    subtitle?: string;
    /** Controls on the title's own line, at the far end (a "publish" button, a filter). */
    actions?: Snippet;
    /** Anything that belongs to the header but below the title row (pills, a search field). */
    children?: Snippet;
  }

  let { title, subtitle, backHref, backLabel, actions, children }: Props = $props();
</script>

<!--
  THE ONE PAGE HEADING.

  NO ICON, ON ANY PAGE (user, 2026-09-09: the agenda, the shop and the dashboard each drew their own
  logo beside the title). A glyph next to a word that already names the page is decoration that
  costs a line of vertical space and makes three pages look like three products. The navigation
  already carries the icons, and it is where the reader looks for them.

  The sizes are the majority convention measured across all 34 routes - `text-2xl` bold, `text-sm`
  muted underneath - which the feed, the shop, the agenda and twenty others already used. The two
  outliers were notifications at `text-xl` and the legal pages at `text-3xl`.

  `font-brand` is NOT set here on purpose: `app.css` already gives every `h1..h6` the brand face, so
  the class the feed carried was a no-op that made one page look deliberate and the rest accidental.
-->
<header class="mb-6">
  {#if backHref && backLabel}
    <a
      href={backHref}
      class="text-text-muted hover:text-text-main mb-1 inline-flex items-center gap-1.5 text-sm transition-colors"
    >
      <ArrowLeft size={15} />
      {backLabel}
    </a>
  {/if}
  <!--
    THE ACTIONS GO UNDER THE TITLE ON A PHONE, and this is not a preference.

    Measured on `/associations` at 393px, 2026-09-09: the two action buttons are `shrink-0` at a
    combined 243.4px of a 355px row, which leaves the title's column **99.6px**. "Associations" is
    wider than that and does not break, so the word overflowed its box and painted straight over the
    "Listes" button - the overlap the user reported (*"L'en-tete de la page associations est moche +
    chevauchements"*) - while the subtitle wrapped into four lines beside it.

    It is fixed HERE rather than on that page because `PageHeader` is the one heading of all 34
    routes: every page with two or more actions had the same squeeze waiting for a long enough
    title, which is the other half of the report (*"Verifier les autres pages sur device"*).

    Stacked and wrapping below `sm`, unchanged from 640px up where the row genuinely has the width.
    `break-words` stays as the floor: a single unbreakable word - an association's name on a detail
    page - must wrap rather than escape its box, whatever the width turns out to be.
  -->
  <div class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="text-text-main text-2xl font-bold tracking-tight break-words">{title}</h1>
      {#if subtitle}
        <p class="text-text-muted mt-0.5 text-sm">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if children}
    <div class="mt-4">{@render children()}</div>
  {/if}
</header>
