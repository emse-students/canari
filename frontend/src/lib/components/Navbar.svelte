<script lang="ts">
  import { Terminal, LogOut } from "lucide-svelte";
  import StatusPill from "./StatusPill.svelte";

  interface Props {
    isWsConnected: boolean;
    onToggleLogs: () => void;
    onLogout: () => void;
  }

  let { isWsConnected, onToggleLogs, onLogout }: Props = $props();
</script>

<header
  class="h-16 bg-white border-b border-cn-border flex items-center justify-between px-6 z-20"
>
  <!-- Brand -->
  <div class="flex items-center gap-3">
    <div
      class="w-8 h-8 bg-cn-dark text-cn-yellow rounded-lg flex items-center justify-center"
    >
      <img src="/favicon.png" alt="Canari" class="w-3/4 h-3/4 object-contain" />
    </div>
    <span class="font-black text-xl text-cn-dark">Canari</span>
  </div>

  <!-- Status -->
  <StatusPill isConnected={isWsConnected} />

  <!-- Actions -->
  <div class="flex gap-2">
    <button
      onclick={onToggleLogs}
      title="Console de logs"
      class="p-2 rounded-lg text-text-muted hover:bg-cn-bg hover:text-cn-dark transition-colors"
    >
      <Terminal size={20} />
    </button>
    <button
      onclick={onLogout}
      title="Fermer la session"
      class="p-2 rounded-lg text-text-muted hover:bg-red-50 hover:text-red-500 transition-colors"
    >
      <LogOut size={20} />
    </button>
  </div>
</header>
