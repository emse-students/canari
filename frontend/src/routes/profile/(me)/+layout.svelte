<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { CircleAlert, LoaderCircle } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { provideMyProfile } from '$lib/profile/myProfileModel.svelte';
  import { m } from '$lib/paraglide/messages';

  let { children } = $props();

  // ONE model for the hub and every section below it: the identity and its extras are fetched once
  // per visit to the area, not once per page. A reload on a section lands here and fetches again.
  const model = provideMyProfile();

  onMount(async () => {
    const outcome = await model.load();
    if (outcome === 'unauthenticated') {
      const back = encodeURIComponent(page.url.pathname);
      await goto(resolve(`/login?returnTo=${back}`), { replaceState: true });
    }
  });
</script>

<!--
  NO `PageHeader` HERE, AND THAT IS NOT AN OMISSION. A profile's title is the person, drawn inside
  the identity card with their avatar - putting their name a second time above it would say it
  twice. A section page carries its own breadcrumb. What this layout owes the rest of the app is
  the COLUMN, and the one load/error gate the hub and every section share.
-->
<PageContainer>
  <div class="space-y-6 md:space-y-8">
    {#if model.loading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-4 py-32" in:fade>
        <LoaderCircle size={32} class="text-cn-yellow animate-spin" strokeWidth={2.5} />
        <span class="text-sm font-bold tracking-wider uppercase">{m.profile_loading()}</span>
      </div>
    {:else if model.error}
      <div
        class="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-600 shadow-sm dark:text-red-400"
        in:slide
      >
        <CircleAlert size={20} class="mt-0.5 shrink-0" />
        <div>
          <h3 class="mb-1 text-sm font-bold">{m.common_generic_error_label()}</h3>
          <p class="text-sm font-medium">{m.profile_load_error_fallback()}</p>
        </div>
      </div>
    {:else if model.profile}
      {@render children?.()}
    {/if}
  </div>
</PageContainer>
