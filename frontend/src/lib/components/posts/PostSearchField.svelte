<script lang="ts">
  import { Search, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';

  /**
   * THE POST SEARCH FIELD WITH ITS TWO ICONS, in a `relative` box of their own. The icons centre on
   * `top-1/2` of the box they are absolute in: when that box also held the filter chips and the
   * pickers (1.8.2), the magnifier sat below the input, on the chips row, on the web and on phones.
   * The filters are rendered by the CALLER, outside this box.
   */
  interface Props {
    value: string;
    /** The clear/close button is drawn while this is true. */
    showClear: boolean;
    oninput: (e: Event & { currentTarget: HTMLInputElement }) => void;
    onclear: () => void;
  }

  let { value, showClear, oninput, onclear }: Props = $props();
</script>

<div class="relative" data-post-search-field>
  <Search
    size={16}
    class="text-text-muted pointer-events-none absolute top-1/2 left-3.5 z-10 -translate-y-1/2"
  />
  <!-- The field is the shared `Input`; the room for the icons and the engine's own cross (the page
       draws its own clear control) is given to its `input` from the box. -->
  <Input
    type="search"
    {value}
    {oninput}
    placeholder={m.posts_search_placeholder()}
    class="[&_input]:pr-10 [&_input]:pl-10 [&_input::-webkit-search-cancel-button]:appearance-none"
  />
  <!-- ONE BUTTON FOR TWO WIDTHS: from `md` up it clears a query, below `md` it closes the field
       (and drops the query - a hidden field still filtering the feed has no visible cause). -->
  {#if showClear}
    <Button
      variant="bare"
      onclick={onclear}
      class="tap-target text-text-muted hover:text-text-main absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
      aria-label={m.common_clear_aria()}
    >
      <X size={16} />
    </Button>
  {/if}
</div>
