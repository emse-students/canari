<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';

  interface Props {
    open: boolean;
    activeTab: 'contact' | 'group';
    contactId: string;
    groupName: string;
    onClose: () => void;
    onTabChange: (tab: 'contact' | 'group') => void;
    onContactIdChange: (value: string) => void;
    onGroupNameChange: (value: string) => void;
    onSubmitContact: () => void;
    onSubmitGroup: () => void;
  }

  let {
    open,
    activeTab,
    contactId,
    groupName,
    onClose,
    onTabChange,
    onContactIdChange,
    onGroupNameChange,
    onSubmitContact,
    onSubmitGroup,
  }: Props = $props();

  // Utilitaires de classes pour garder le template HTML propre
  const baseTabClass = "flex-1 px-3 py-2 text-sm font-semibold rounded-xl transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-400";
  const activeTabClass = "bg-white/80 dark:bg-black/40 text-text-main border border-white/60 dark:border-white/10 shadow-sm";
  const inactiveTabClass = "text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30 border border-transparent";

  // Gestionnaires de soumission natifs
  function handleContactSubmit(e: Event) {
    e.preventDefault();
    if (contactId.trim()) onSubmitContact();
  }

  function handleGroupSubmit(e: Event) {
    e.preventDefault();
    if (groupName.trim()) onSubmitGroup();
  }
</script>

<Modal {open} {onClose} title="Nouvelle discussion">
  <!-- Système d'onglets accessible -->
  <div
    role="tablist"
    class="flex gap-2 rounded-2xl bg-white/45 dark:bg-black/25 border border-white/50 dark:border-white/10 p-1 mb-4"
  >
    <button
      id="tab-contact"
      role="tab"
      aria-selected={activeTab === 'contact'}
      aria-controls="tabpanel-contact"
      class="{baseTabClass} {activeTab === 'contact' ? activeTabClass : inactiveTabClass}"
      onclick={() => onTabChange('contact')}
    >
      Contact
    </button>
    <button
      id="tab-group"
      role="tab"
      aria-selected={activeTab === 'group'}
      aria-controls="tabpanel-group"
      class="{baseTabClass} {activeTab === 'group' ? activeTabClass : inactiveTabClass}"
      onclick={() => onTabChange('group')}
    >
      Groupe
    </button>
  </div>

  <!-- Contenu des onglets -->
  {#if activeTab === 'contact'}
    <div id="tabpanel-contact" role="tabpanel" aria-labelledby="tab-contact">
      <form
        class="space-y-4"
        onsubmit={handleContactSubmit}
      >
        <div>
          <label for="new-contact-id" class="block text-sm font-medium text-text-main mb-1">
            Contact
          </label>
          <UserAutocomplete
            value={contactId}
            onValueChange={onContactIdChange}
            placeholder="Rechercher un nom..."
            inputId="new-contact-id"
            onSubmit={onSubmitContact}
          />
        </div>
        <button
          type="submit"
          disabled={!contactId.trim()}
          class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Démarrer la discussion
        </button>
      </form>
    </div>
  {:else if activeTab === 'group'}
    <div id="tabpanel-group" role="tabpanel" aria-labelledby="tab-group">
      <form
        class="space-y-4"
        onsubmit={handleGroupSubmit}
      >
        <div>
          <label for="new-group-name" class="block text-sm font-medium text-text-main mb-1">
            Nom du groupe
          </label>
          <input
            id="new-group-name"
            type="text"
            value={groupName}
            oninput={(e) => onGroupNameChange(e.currentTarget.value)}
            placeholder="ex: Projet Canari"
            class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45 focus:border-amber-400/50 transition-all placeholder:text-text-muted/70"
            autocomplete="off"
          />
        </div>
        <button
          type="submit"
          disabled={!groupName.trim()}
          class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Créer le groupe
        </button>
      </form>
    </div>
  {/if}
</Modal>
