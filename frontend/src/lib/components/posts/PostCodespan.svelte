<script lang="ts">
  interface Props {
    raw: string;
  }

  let { raw }: Props = $props();

  const text = $derived(raw.replace(/^`|`$/g, ''));
</script>

<code
  class="text-text-main rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[0.88em] dark:bg-white/10"
  >{text}</code
>
