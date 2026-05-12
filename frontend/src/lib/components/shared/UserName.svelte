<script lang="ts">
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';

  interface Props {
    /** User ID used to resolve the display name. */
    userId: string;
    /** Text shown while the display name is being resolved. */
    fallback?: string;
    /** Additional CSS classes applied to the rendered element. */
    class?: string;
    /** When true, wraps the name in a profile link; otherwise renders a plain span. */
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
