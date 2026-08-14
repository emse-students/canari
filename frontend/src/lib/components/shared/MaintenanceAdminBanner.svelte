<script lang="ts">
  import { getAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import { TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';

  const info = $derived(getAppVersionCheck());
  const message = $derived(info?.maintenance.message);
</script>

<!-- No placement of its own: `+layout.svelte` stacks the window-scale banners in one fixed column,
     so two of them showing at once queue up instead of one hiding the other. -->
<Banner variant="notice" center class="font-bold">
  <TriangleAlert size={14} aria-hidden="true" />
  <span>
    {m.admin_maintenance_banner_text()}
    {#if message}
      {message}
    {/if}
  </span>
</Banner>
