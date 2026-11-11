<script lang="ts">
  /**
   * A test stand-in for `ProfileHeader`: the name and the two snippets it is given, with no avatar
   * (whose read goes to the network).
   */
  import type { Snippet } from 'svelte';

  let { name, details, actions }: { name: string; details?: Snippet; actions?: Snippet } = $props();
</script>

<h1 data-stub="profile-name">{name}</h1>
{@render details?.()}
{@render actions?.()}
