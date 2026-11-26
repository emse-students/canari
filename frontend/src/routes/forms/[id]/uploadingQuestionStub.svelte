<script lang="ts">
  /** Test stand-in for `FormQuestion`: a question whose file is always still uploading. */
  import { onMount } from 'svelte';
  let { onUploadingChange }: { onUploadingChange?: (uploading: boolean) => void } = $props();
  onMount(() => onUploadingChange?.(true));
</script>

<p>uploading question</p>
