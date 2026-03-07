<script lang="ts">
  import { ChevronLeft, LockKeyhole, Clock } from "lucide-svelte";

  interface Props {
    contactName: string;
    displayName: string;
    isReady: boolean;
    inviteMemberInput: string;
    onInviteInputChange: (value: string) => void;
    onInviteMember: () => void;
    onBack?: () => void;
  }

  let {
    contactName,
    displayName,
    isReady,
    inviteMemberInput,
    onInviteInputChange,
    onInviteMember,
    onBack,
  }: Props = $props();

  const avatarLetter = $derived(contactName[0]?.toUpperCase() || "?");

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && inviteMemberInput.trim()) {
      onInviteMember();
    }
  }
</script>

<header
  class="bg-white px-6 py-3 border-b border-cn-border flex items-center gap-4"
>
  <!-- Back button (mobile) -->
  {#if onBack}
    <button
      onclick={onBack}
      aria-label="Retour au menu"
      class="md:hidden p-1 text-cn-dark"
    >
      <ChevronLeft size={24} />
    </button>
  {/if}

  <!-- Avatar -->
  <div
    class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center font-extrabold flex-shrink-0"
  >
    {avatarLetter}
  </div>

  <!-- Meta -->
  <div class="flex-1 min-w-0">
    <h2 class="text-lg font-semibold text-cn-dark mb-1">{displayName}</h2>
    <span
      class="inline-flex items-center gap-1.5 text-xs font-semibold {isReady
        ? 'text-green-500'
        : 'text-amber-600'}"
    >
      {#if isReady}
        <LockKeyhole size={14} /> Bout-en-bout vérifié
      {:else}
        <Clock size={14} /> Négociation cryptographique...
      {/if}
    </span>
  </div>

  <!-- Invite -->
  <div class="hidden md:flex gap-2">
    <input
      type="text"
      value={inviteMemberInput}
      oninput={(e) => onInviteInputChange(e.currentTarget.value)}
      onkeydown={handleKeydown}
      placeholder="Ajouter au groupe..."
      class="px-2 py-2 border border-cn-border rounded-lg text-sm w-32 outline-none focus:border-cn-yellow"
    />
    <button
      onclick={onInviteMember}
      class="px-3 py-2 bg-cn-dark text-white rounded-lg text-sm font-semibold hover:bg-gray-800 transition-colors"
    >
      Inviter
    </button>
  </div>
</header>
