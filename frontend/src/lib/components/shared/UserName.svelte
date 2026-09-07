<script lang="ts">
  import { userDisplayName } from '$lib/utils/users/displayNames.svelte';

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

  // ONE IMPLEMENTATION, shared with every other place that turns an id into a name - see
  // `displayNames.svelte.ts` for why the sync read comes first and why a `null` resolve is ignored.
  const resolved = userDisplayName(
    () => userId,
    () => fallback
  );
  const displayName = $derived(resolved.current);
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
