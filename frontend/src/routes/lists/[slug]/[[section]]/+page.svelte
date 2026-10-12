<script lang="ts">
  import { page } from '$app/state';
  import AssociationDetailView from '$lib/components/associations/AssociationDetailView.svelte';

  const slug = $derived((page.params as Record<string, string>).slug);
</script>

<AssociationDetailView {slug} kind="list" />
