<script lang="ts">
  import { getAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import { TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';

  const info = $derived(getAppVersionCheck());
  const message = $derived(info?.maintenance.message);
  const fullText = $derived([m.admin_maintenance_banner_text(), message].filter(Boolean).join(' '));
</script>

<!-- No placement of its own: `+layout.svelte` stacks the window-scale banners in one fixed column,
     so two of them showing at once queue up instead of one hiding the other. -->
<Banner variant="notice" center class="font-bold">
  <TriangleAlert size={14} class="shrink-0" aria-hidden="true" />
  <!-- The admin's free text can be long: one truncated line on screen, the whole of it in the
       tooltip and in a screen-reader-only copy (the visible line is hidden from the reader so it is
       not read twice). -->
  <span class="truncate" title={fullText} aria-hidden="true">{fullText}</span>
  <span class="sr-only">{fullText}</span>
</Banner>
