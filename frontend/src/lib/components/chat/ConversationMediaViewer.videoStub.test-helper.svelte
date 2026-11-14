<script lang="ts" module>
  /** What the stub player lived through, in order: the viewer tests read it. */
  export const videoStubEvents: string[] = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  let { src }: { src: string; [key: string]: unknown } = $props();
  onMount(() => {
    videoStubEvents.push('mount');
    return () => {
      videoStubEvents.push('destroy');
    };
  });
</script>

<div data-video-stub>{src}</div>
