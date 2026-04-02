<script lang="ts">
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';

  interface Props {
    userId: string;
    fallback?: string;
    class?: string;
  }

  let { userId, fallback, class: className = '' }: Props = $props();

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

<span class={className}>{displayName}</span>
