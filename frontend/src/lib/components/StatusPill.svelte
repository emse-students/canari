<script lang="ts">
  interface Props {
    isConnected: boolean;
  }

  let { isConnected }: Props = $props();
</script>

<div class="flex items-center">
  <div
    class="flex items-center gap-2 px-3 py-2 bg-cn-bg rounded-full text-xs font-bold text-text-main"
  >
    <span
      class="w-2 h-2 rounded-full {isConnected
        ? 'bg-green-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
        : 'bg-gray-400'}"
    ></span>
    {isConnected ? "Réseau Connecté" : "Hors-ligne"}
  </div>
</div>
