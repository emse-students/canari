<script lang="ts">
  /**
   * A test stand-in for `NotificationRow`: it records each mount under the ids its group holds, in
   * `globalThis.__mounts`, so a test can tell which rows were drawn.
   */
  import { onMount } from 'svelte';

  let { notif }: { notif?: { notificationIds: string[] } } = $props();

  onMount(() => {
    const store = ((globalThis as Record<string, unknown>).__mounts ??= []) as string[];
    store.push(notif?.notificationIds.join(',') ?? '?');
  });
</script>

<div data-stub="notification-row">{notif?.notificationIds.join(',') ?? ''}</div>
