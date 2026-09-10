<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ArrowLeft, ChevronRight, List } from '@lucide/svelte';
  import { page } from '$app/state';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { m } from '$lib/paraglide/messages';
  import { LEGAL_DOCUMENTS, type LegalSection } from './legalDocuments';

  interface Props {
    /** The document's own title, already localized. */
    title: string;
    /** One line under it, already localized. */
    subtitle: string;
    /**
     * When the text last changed, `DD/MM/YYYY`. It is a FACT ABOUT THE DOCUMENT, so each page
     * states its own - a shared constant would silently backdate the two that did not change.
     */
    updated: string;
    /** The sections, in order. Empty for a document short enough to read in one screen. */
    sections?: readonly LegalSection[];
    children: Snippet;
  }

  let { title, subtitle, updated, sections = [], children }: Props = $props();

  /** The other two documents. Derived from the route so no page lists its own siblings. */
  const siblings = $derived(LEGAL_DOCUMENTS.filter((doc) => doc.href !== page.url.pathname));

  /** Which section the reader is in, for the rail. Empty until the observer first fires. */
  let activeId = $state('');

  // WHY AN OBSERVER AND NOT `:target`: `:target` only changes when the reader CLICKS the rail, so
  // scrolling through fifteen sections leaves it pointing at whichever one was clicked last - or
  // at nothing at all. The rail's job is to say where you ARE, which only the scroll position
  // knows. The band is the top of the viewport, which is why the bottom margin is large and
  // negative: a section becomes current once its heading has passed the reading line.
  $effect(() => {
    if (sections.length === 0) return;
    const headings = sections
      .map((section) => document.getElementById(section.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // A PLAIN RECORD AND NOT REACTIVE STATE. The observer fires per intersection change, not per
    // section, so it only ever learns about the ones that just crossed the band and has to
    // remember the rest. `activeId` is the single reactive value; this is its working set, and
    // making it reactive would re-run this effect and re-create the observer on every scroll.
    const inBand: Record<string, boolean> = {};
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) inBand[entry.target.id] = entry.isIntersecting;
        // The FIRST section still in the band, in DOCUMENT order - `entries` arrives in whatever
        // order the browser noticed the changes, so it cannot be read positionally.
        const current = sections.find((section) => inBand[section.id]);
        if (current) activeId = current.id;
      },
      { rootMargin: '-15% 0px -70% 0px' }
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  });
</script>

<!--
  THE SHELL EVERY LEGAL DOCUMENT WEARS, AND THE THREE THINGS IT STOPPED BEING.

  The CGU, the privacy policy and the child-safety page carried the SAME 40 lines of chrome, copied
  three times: a scroll wrapper, a translucent card, a centred logo-and-title header, a table of
  contents and a footer. Byte-identical, so three places to change and three places to forget.

  It was also, in the user's words on 2026-09-10, *"vraiment pauvre"*, and that had three causes
  worth naming because each is a rule rather than a taste:

  1. THE DOCUMENT'S OWN TEXT WAS SET AS CAPTION TEXT. Nearly every paragraph carried
     `text-text-muted text-sm` - the secondary colour, at the secondary size, for the whole body of
     a legally binding document. A muted colour means "this is subordinate to something", and here
     there was nothing for it to be subordinate to. The body is now `--text-main` at `--text-base`,
     and the rules live at the bottom of this file so no page can drift from them.
  2. EVERYTHING WAS A CARD. Definitions, contacts, moderation steps and warnings all wore
     `rounded-xl border bg-white/10`. When every block is lifted, none is - so the two blocks that
     genuinely are warnings, the encryption note and the CSAE prohibition, read exactly like a list
     of defined terms. Cards are now spent on callouts only, and a definition list is a `<dl>`.
  3. IT WORE THE LOGIN SCREEN'S CLOTHES. `bg-white/20`, `border-white/40`, `shadow-2xl` and a
     centred favicon are the auth card's glass. That works over the auth screen's backdrop and
     floats over nothing on a document route. A document does not need a container to sit in; it
     needs a MEASURE, and it now uses the shared one.

  The fourth fault was structural rather than visual: `max-w-2xl` (672px) was a FIFTH page width,
  outside the three `pageWidth.ts` allows, and it sat on the same element as the header, so it
  capped the chrome too.
-->
<PageContainer width="reading">
  {#snippet aside()}
    {#if sections.length > 0}
      <!-- Hidden until `xl`, where the window is wide enough that the rail costs the document
           nothing. Below it the same list renders as a closed `<details>` above the text. -->
      <nav class="hidden w-56 shrink-0 xl:block" aria-label={m.legal_toc_heading()}>
        <div class="sticky top-8">
          <p class="text-text-muted text-2xs mb-3 font-semibold tracking-widest uppercase">
            {m.legal_toc_heading()}
          </p>
          <ul class="space-y-0.5 text-xs">
            {#each sections as section (section.id)}
              <li>
                <a
                  href="#{section.id}"
                  aria-current={activeId === section.id ? 'true' : undefined}
                  class="block border-l-2 py-1 pl-3 transition-colors {activeId === section.id
                    ? 'border-cn-yellow text-text-main font-semibold'
                    : 'text-text-muted hover:text-text-main border-transparent'}"
                >
                  {section.label}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      </nav>
    {/if}
  {/snippet}

  <button
    onclick={() => history.back()}
    class="text-text-muted hover:text-text-main mb-8 inline-flex items-center gap-1.5 text-xs transition-colors"
  >
    <ArrowLeft size={14} />
    {m.common_back()}
  </button>

  <header class="border-cn-border mb-8 border-b pb-8">
    <p class="text-text-muted text-2xs mb-2 font-semibold tracking-widest uppercase">
      {m.legal_eyebrow()}
    </p>
    <h1 class="text-text-main text-3xl font-bold tracking-tight text-balance">{title}</h1>
    <p class="text-text-muted mt-2 text-base">{subtitle}</p>
    <p class="text-text-muted text-2xs mt-4">{m.legal_last_updated({ date: updated })}</p>
  </header>

  {#if sections.length > 0}
    <!-- The rail's narrow-viewport half. Closed by default: on a phone an open list of fifteen
         entries is a screenful of links between the reader and the document's first word. -->
    <details class="border-cn-border mb-8 rounded-2xl border xl:hidden">
      <summary
        class="text-text-main flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold"
      >
        <List size={15} />
        {m.legal_toc_heading()}
      </summary>
      <ul class="text-text-muted space-y-1 px-4 pb-4 text-sm">
        {#each sections as section (section.id)}
          <li><a href="#{section.id}" class="hover:text-text-main">{section.label}</a></li>
        {/each}
      </ul>
    </details>
  {/if}

  <div class="legal-prose text-text-main">
    {@render children()}
  </div>

  <footer class="border-cn-border mt-14 border-t pt-8">
    <div class="grid gap-3 sm:grid-cols-2">
      {#each siblings as doc (doc.href)}
        <a
          href={doc.href}
          class="border-cn-border hover:border-cn-yellow group flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 transition-colors"
        >
          <span class="text-text-main text-sm font-semibold">{doc.label()}</span>
          <ChevronRight
            size={16}
            class="text-text-muted group-hover:text-cn-yellow transition-colors"
          />
        </a>
      {/each}
    </div>
    <p class="text-text-muted text-2xs mt-6">{m.legal_footer_credits()}</p>
  </footer>
</PageContainer>

<!--
  THE DOCUMENT'S TYPOGRAPHY, SET ONCE ON THE ELEMENTS THEMSELVES.

  The pages inside this shell are plain HTML - `h2`, `p`, `ul` - and carry no classes for type or
  colour, which is the point: three documents totalling ~900 lines cannot hold one measure if every
  paragraph restates it, and they did not. `:global()` because the markup belongs to the CHILD, so
  Svelte's scoping would strip every one of these rules.

  `scroll-margin-top` on the headings is what makes the rail's anchors land right - without it a
  jump puts the heading flush against the viewport's top edge.
-->
<style>
  .legal-prose :global(> * + *) {
    margin-top: 2.5rem;
  }

  /* The rail's anchors point at the SECTION, not at its heading, so the scroll margin belongs
     here - on the heading it would be ignored and every jump would land flush against the top. */
  .legal-prose :global(section) {
    scroll-margin-top: 2rem;
  }

  .legal-prose :global(h2) {
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-bottom: 1rem;
  }

  .legal-prose :global(h3) {
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
    font-weight: 600;
    margin-top: 1.75rem;
    margin-bottom: 0.5rem;
  }

  .legal-prose :global(p),
  .legal-prose :global(li) {
    font-size: var(--text-base);
    line-height: 1.7;
  }

  .legal-prose :global(p + p),
  .legal-prose :global(p + ul),
  .legal-prose :global(ul + p) {
    margin-top: 1rem;
  }

  .legal-prose :global(ul:not(.legal-terms)) {
    list-style: disc;
    padding-left: 1.25rem;
  }

  .legal-prose :global(ul:not(.legal-terms) li + li) {
    margin-top: 0.5rem;
  }

  .legal-prose :global(a) {
    color: var(--cn-yellow);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .legal-prose :global(strong) {
    font-weight: 600;
  }

  /*
    A DEFINITION LIST IS A DEFINITION LIST. This replaces the `<li class="rounded-xl border
    bg-white/10">` cards the three pages used for defined terms, sub-clauses and contact blocks -
    twenty-odd of them, so twenty-odd boxes competing with the two that are real warnings. A
    hanging rule marks the term and costs no elevation.
  */
  .legal-prose :global(.legal-terms) {
    display: grid;
    gap: 1rem;
    list-style: none;
    padding-left: 0;
  }

  .legal-prose :global(.legal-terms > div),
  .legal-prose :global(.legal-terms > li),
  .legal-prose :global(.legal-block) {
    border-left: 2px solid var(--cn-border);
    padding-left: 1rem;
  }

  /* A block that states its own subject rather than a term/definition pair: a sub-processor, a
     contact, a breach-notification clause. Same rule, its own heading. */
  .legal-prose :global(.legal-block) {
    display: grid;
    gap: 0.5rem;
  }

  .legal-prose :global(.legal-block-title) {
    font-weight: 600;
  }

  /* The one place a smaller, muted tier is right: a note ABOUT the clause above it. It is
     subordinate to something, which is what the whole body wrongly claimed to be. */
  .legal-prose :global(.legal-fineprint) {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    color: var(--text-muted);
  }

  .legal-prose :global(.legal-terms dt) {
    font-size: var(--text-base);
    line-height: 1.7;
    font-weight: 600;
  }

  .legal-prose :global(.legal-terms dd) {
    font-size: var(--text-base);
    line-height: 1.7;
    color: var(--text-muted);
    margin-left: 0;
  }

  /*
    The two REAL callouts, and the reason cards came off everything else: `.legal-note` for a point
    the reader must not miss, `.legal-alert` for a prohibition. Colour carries the difference, and
    both keep the body's own type.
  */
  .legal-prose :global(.legal-note),
  .legal-prose :global(.legal-alert) {
    border-radius: var(--radius-2xl);
    border-width: 1px;
    border-style: solid;
    padding: 1.25rem;
  }

  .legal-prose :global(.legal-note) {
    border-color: color-mix(in srgb, var(--cn-yellow) 30%, transparent);
    background: color-mix(in srgb, var(--cn-yellow) 6%, transparent);
  }

  .legal-prose :global(.legal-alert) {
    border-color: color-mix(in srgb, var(--red-err) 30%, transparent);
    background: color-mix(in srgb, var(--red-err) 6%, transparent);
  }

  .legal-prose :global(.legal-note > .legal-callout-title) {
    color: var(--cn-yellow);
  }

  .legal-prose :global(.legal-alert > .legal-callout-title) {
    color: var(--red-err);
  }

  .legal-prose :global(.legal-callout-title) {
    font-weight: 700;
    margin-bottom: 0.5rem;
  }
</style>
