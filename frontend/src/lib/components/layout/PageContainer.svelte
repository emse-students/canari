<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /**
     * Widen the column to the tool width.
     *
     * THE DEFAULT IS THE ONLY WIDTH A BROWSING PAGE MAY HAVE. This escape hatch exists for the few
     * surfaces that are editors rather than documents - a form builder, an export table, a
     * moderation board - where 680px genuinely cannot hold the controls. It is a SECOND declared
     * value, not a free one: if a third width is ever wanted, the answer is to ask why that page is
     * neither of these two shapes.
     */
    wide?: boolean;
    /** Drop the entrance animation (a page that owns its own transition). */
    still?: boolean;
    /**
     * A column beside the content, outside the reading width - the feed's conversations panel. It is
     * the caller's job to hide it on narrow viewports.
     */
    aside?: Snippet;
    /** Extra classes for the column itself. */
    class?: string;
    children: Snippet;
  }

  let { wide = false, still = false, aside, class: extra = '', children }: Props = $props();
</script>

<!--
  THE ONE PAGE COLUMN.

  Before this existed every route invented its own: the feed at 42.5rem, notifications at 36rem, the
  agenda at 48rem, the shop and the dashboard at 56rem, and the padding differed on each. Nothing
  chose those numbers - they were whatever the page that came first happened to carry - and the
  visible result was that moving between two tabs of the same app moved the text under the reader.

  The value is the FEED's, which the user named as the reference page, and so is the vertical
  rhythm. There is deliberately NO bottom padding for the mobile tab bar: the shell's scroll wrapper
  already reserves `4rem + safe-area`, and the pages that added their own were padding twice.

  This is a `div` and not a `main` because the shell already renders `<main id="main-content">`
  around every page - the routes that declared their own were nesting a landmark inside itself,
  which is invalid and leaves a screen reader two "main" regions to choose between.
-->
<div class="flex gap-6 px-4 py-6 md:px-8 md:py-8">
  <div class="min-w-0 flex-1">
    <div
      class="mx-auto w-full {wide ? 'max-w-5xl' : 'max-w-[42.5rem]'} {still
        ? ''
        : 'animate-rise-in'} {extra}"
    >
      {@render children()}
    </div>
  </div>
  {#if aside}
    {@render aside()}
  {/if}
</div>
