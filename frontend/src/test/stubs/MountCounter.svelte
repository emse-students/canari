<script lang="ts">
  /**
   * A test stand-in for a heavy child component: it records each mount under its `post.id` (or
   * `'?'`) in `globalThis.__mounts`, so a test can tell one mount from a remount.
   */
  import { onMount } from 'svelte';

  let { post }: { post?: { id: string } } = $props();

  onMount(() => {
    const store = ((globalThis as Record<string, unknown>).__mounts ??= []) as string[];
    store.push(post?.id ?? '?');
  });
</script>

<div data-stub="mount-counter">{post?.id ?? ''}</div>
