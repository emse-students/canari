<script lang="ts">
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';

  interface Props {
    userId: string;
    fallback?: string;
    class?: string;
    link?: boolean;
  }

  let { userId, fallback, class: className = '', link = true }: Props = $props();

  let displayName = $state('');

  $effect(() => {
    // First show the sync version (from cache or initial)
    displayName = getUserDisplayNameSync(userId, fallback);

    // Then resolve async to update if needed
    resolveUserDisplayName(userId).then((resolved) => {
      if (resolved) {
        displayName = resolved;
      }
    });
  });
</script>

{#if link}
  <a
    href="/profile/{encodeURIComponent(userId)}"
    class="{className} hover:underline"
    onclick={(e) => e.stopPropagation()}>{displayName}</a
  >
{:else}
  <span class={className}>{displayName}</span>
{/if}
