<script lang="ts">
  /**
   * THE FEED'S (i) BUTTON (owner, 2026-11-01): what each tab shows and who sees what, in a small
   * sheet on a phone and a popover on a wide window (`FloatingSurface`, the same shell as `Picker`).
   * It sits at the right end of the tab row, beside the CanaReels entry, as the same round glass
   * button. The texts are the real rules: [posts](docs/wiki/frontend/modules/posts.md#feed-tabs).
   */
  import { Info } from '@lucide/svelte';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import { m } from '$lib/paraglide/messages';

  /** Same breakpoint as `Picker`: below it the surface is a bottom sheet. */
  const SHEET_QUERY = '(width < 40rem)';

  let open = $state(false);
  let asSheet = $state(false);
  let trigger = $state<HTMLElement | null>(null);

  const ENTRIES: { title: () => string; body: () => string }[] = [
    { title: m.posts_tabs_info_associations_title, body: m.posts_tabs_info_associations_body },
    { title: m.posts_tabs_info_followed_title, body: m.posts_tabs_info_followed_body },
    { title: m.posts_tabs_info_all_title, body: m.posts_tabs_info_all_body },
  ];

  function toggle() {
    // The shape is fixed when it opens, so it never changes under the finger that opened it.
    asSheet = window.matchMedia(SHEET_QUERY).matches;
    open = !open;
    console.debug(
      `[feed-tabs] info ${open ? 'opened' : 'closed'} as ${asSheet ? 'sheet' : 'popover'}`
    );
  }

  function close(refocus: boolean) {
    open = false;
    if (refocus) trigger?.focus();
  }
</script>

<button
  type="button"
  bind:this={trigger}
  data-feed-tabs-info
  aria-label={m.posts_tabs_info_open()}
  title={m.posts_tabs_info_open()}
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={toggle}
  class="glass-chrome ui-icon-button text-text-muted hover:text-text-main rounded-full focus-visible:ring-2 focus-visible:ring-amber-500"
>
  <Info size={18} aria-hidden="true" />
</button>

<FloatingSurface
  {open}
  {asSheet}
  anchor={trigger}
  label={m.posts_tabs_info_title()}
  onClose={close}
  popoverWidth="content"
>
  <dl class="flex flex-col gap-3 px-3 py-2 sm:max-w-80">
    {#each ENTRIES as entry (entry.title())}
      <div>
        <dt class="text-text-main text-sm font-semibold">{entry.title()}</dt>
        <dd class="text-text-muted text-sm">{entry.body()}</dd>
      </div>
    {/each}
  </dl>
</FloatingSurface>
