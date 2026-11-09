<script lang="ts">
  import { Bold, Code, Heading2, Italic, Link2, List, Quote, Strikethrough } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Called with format id (`bold`, `italic`, `heading`, ...). */
    onFormat: (type: string) => void;
    class?: string;
    /**
     * The class of one LABELLED button, to draw the actions as the chips of a composer's pinned bottom
     * bar (icon and word, wrapping onto as many rows as the width needs) instead of the icon-only
     * block that heads an editor. It is how the post composer's formatting row fills the room its
     * attachment chips take, so the swap between the two moves nothing.
     */
    chipClass?: string;
  }

  let { onFormat, class: className = '', chipClass }: Props = $props();

  /** One entry per format id `applyComposerMarkdownFormat` knows, in toolbar order; `null` is a rule. */
  const ACTIONS = [
    { id: 'bold', icon: Bold, label: () => m.md_toolbar_bold() },
    { id: 'italic', icon: Italic, label: () => m.md_toolbar_italic() },
    { id: 'strikethrough', icon: Strikethrough, label: () => m.md_toolbar_strikethrough() },
    null,
    { id: 'heading', icon: Heading2, label: () => m.md_toolbar_heading() },
    { id: 'quote', icon: Quote, label: () => m.md_toolbar_quote() },
    { id: 'code', icon: Code, label: () => m.md_toolbar_code() },
    null,
    { id: 'list', icon: List, label: () => m.md_toolbar_list() },
    { id: 'link', icon: Link2, label: () => m.md_toolbar_link() },
  ] as const;

  const layoutClass = $derived(
    chipClass
      ? 'flex-wrap gap-2'
      : 'flex-wrap gap-0.5 border-b border-black/5 px-2 pt-1.5 pb-1.5 dark:border-white/5'
  );

  const iconButtonClass =
    'ui-icon-button rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500';
</script>

<div
  class="flex items-center {layoutClass} {className}"
  role="toolbar"
  tabindex="-1"
  aria-label={m.md_toolbar_aria_label()}
  onmousedown={(e) => e.preventDefault()}
>
  {#each ACTIONS as action, i (action ? action.id : `rule-${i}`)}
    {#if action === null}
      {#if !chipClass}
        <div class="mx-1 h-4 w-px shrink-0 bg-black/10 dark:bg-white/10" aria-hidden="true"></div>
      {/if}
    {:else if chipClass}
      <button
        type="button"
        title={action.label()}
        class={chipClass}
        onclick={() => onFormat(action.id)}
      >
        <action.icon size={16} strokeWidth={2.25} />
        {action.label()}
      </button>
    {:else}
      <button
        type="button"
        title={action.label()}
        class={iconButtonClass}
        onclick={() => onFormat(action.id)}
      >
        <action.icon size={15} strokeWidth={2} />
      </button>
    {/if}
  {/each}
</div>
