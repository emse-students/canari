<script lang="ts">
  /**
   * "NOS PRINCIPES", THE CHARTER, RENDERED FROM THE ONE TEXT (`docs/principes.md`).
   *
   * The text is imported at build time (`?raw`), never copied into a component or a message file,
   * so the repository page and this page cannot drift apart. It is FRENCH ONLY, even in the English
   * interface (owner, 2026-11-10): a charter is a commitment, and a translation would be a second
   * text to keep in step. Only the entry label and the page title go through Paraglide.
   *
   * The leading `# Nos principes` is dropped here because the page already carries that title as
   * its heading; the rest is rendered as written, with plain markdown (paragraphs wrap on blank
   * lines, not on every newline - the source is hard-wrapped).
   */
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import charter from '../../../../../docs/principes.md?raw';

  /** The charter without its own title line. */
  const body = charter.replace(/^# [^\n]*\r?\n+/, '');
</script>

<article
  lang="fr"
  data-principles-document
  class="post-markdown border-cn-border [&_h2]:text-text-main [&_p]:text-text-main [&_ul]:text-text-main rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8 [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:leading-snug [&_h2]:font-bold [&_h2:first-child]:mt-0 [&_li]:mt-1 [&_p]:mt-3 [&_p]:text-sm [&_p]:leading-relaxed [&_p:first-child]:mt-0 [&_strong]:font-bold [&_ul]:text-sm [&_ul]:leading-relaxed"
>
  <SvelteMarkdown source={body} options={{ gfm: true, breaks: false }} />
</article>
