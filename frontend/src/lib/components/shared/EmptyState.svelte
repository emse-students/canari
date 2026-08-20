<script lang="ts">
  import type { Component } from 'svelte';

  interface Props {
    /** Lucide (or compatible) icon component rendered above the title. */
    icon: Component;
    /** Pixel size passed to the icon component. */
    iconSize?: number;
    /** Bold heading displayed below the icon. */
    title: string;
    /** Descriptive paragraph shown below the title. */
    description: string;
  }

  let { icon: Icon, iconSize = 64, title, description }: Props = $props();
</script>

<div class="text-text-muted flex flex-1 flex-col items-center justify-center p-8 text-center">
  <div class="mb-4 opacity-20">
    <Icon size={iconSize} />
  </div>
  <h2 class="text-cn-dark mb-2 text-xl font-semibold">{title}</h2>
  <p class="max-w-md">{description}</p>
</div>
