<script lang="ts">
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import PrinciplesDocument from '$lib/components/settings/PrinciplesDocument.svelte';
  import { settingsTrail } from '$lib/settings/settingsSections';
  import { m } from '$lib/paraglide/messages';

  // Settings > About > Nos principes: the page hangs under "About", where it is reached from.
  const crumbs = $derived([
    ...settingsTrail('about', m.settings_page_title()),
    { label: m.settings_principles_label(), href: '/settings/principes' },
  ]);
</script>

<Breadcrumb {crumbs} />

<div class="space-y-6 md:space-y-8">
  <PrinciplesDocument />
</div>
