<script lang="ts">
  /**
   * DEV ONLY (`+page.ts` answers 404 in every build). The preview is imported behind
   * `import.meta.env.DEV`, a constant false in a build, so neither it nor its invented mailbox is
   * bundled. `?view=` picks the screen: inbox, thread, html, compose, folders, selection, signin,
   * pending, error.
   */
  import type { Component } from 'svelte';
  import { Log } from '$lib/utils/Log';

  let Preview = $state<Component | null>(null);

  if (import.meta.env.DEV) {
    void import('../../../test/mailPreview/MailPreview.svelte').then(
      (mod) => (Preview = mod.default as Component),
      (err) => Log.w('MAIL-PREVIEW', 'ERROR: the preview did not load', err)
    );
  }
</script>

{#if Preview}
  <Preview />
{/if}
