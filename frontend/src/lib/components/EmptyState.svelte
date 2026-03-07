<script lang="ts">
  import type { ComponentType } from "svelte";

  interface Props {
    icon: ComponentType;
    iconSize?: number;
    title: string;
    description: string;
  }

  let { icon: Icon, iconSize = 64, title, description }: Props = $props();
</script>

<div
  class="flex-1 flex flex-col items-center justify-center text-center p-8 text-text-muted"
>
  <div class="mb-4 opacity-20">
    <Icon size={iconSize} />
  </div>
  <h2 class="text-cn-dark text-xl font-semibold mb-2">{title}</h2>
  <p class="max-w-md">{description}</p>
</div>
