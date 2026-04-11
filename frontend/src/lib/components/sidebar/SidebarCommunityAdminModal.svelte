<script lang="ts">
  import { Settings, Users, Trash2, ShieldCheck, Upload, Loader } from 'lucide-svelte';
  import Modal from '../shared/Modal.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';

  interface ChannelItem {
    id: string;
    name: string;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    imageMediaId?: string | null;
    workspaceDbId?: string;
    channels: ChannelItem[];
  }

  interface Props {
    open: boolean;
    workspaces: ChannelWorkspace[];
    selectedWorkspaceId: string;
    onClose: () => void;
    onUpdateWorkspaceImage?: (workspaceDbId: string, mediaId: string) => void;
  }

  let { open, workspaces, selectedWorkspaceId, onClose, onUpdateWorkspaceImage }: Props = $props();

  let activeTab = $state<'overview' | 'members'>('overview');

  let selectedWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  );

  // Image upload state
  let imageUploading = $state(false);
  let imageUploadError = $state('');
  const mediaService = new MediaService();

  async function handleImageFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !selectedWorkspace?.id) return;

    if (!file.type.startsWith('image/')) {
      imageUploadError = 'Veuillez sélectionner une image.';
      return;
    }

    imageUploading = true;
    imageUploadError = '';
    try {
      const token = await getToken();
      const mediaId = await mediaService.uploadRaw(file, token);
      // Pass workspaceDbId if available, otherwise fall back to the slug id
      const targetId = selectedWorkspace.workspaceDbId ?? selectedWorkspace.id;
      onUpdateWorkspaceImage?.(targetId, mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : 'Échec du téléversement.';
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }
</script>

<Modal {open} {onClose} title="Paramètres de la communauté" maxWidth="max-w-4xl">
  <div class="flex flex-col md:flex-row min-h-0 border-t border-cn-border/40">
    <!-- Barre de menu à gauche -->
    <div
      class="w-full md:w-64 md:flex-shrink-0 bg-[color-mix(in_srgb,var(--cn-surface)_60%,white)] border-b md:border-b-0 md:border-r border-cn-border/40 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-2 md:p-4 gap-1 md:gap-1 md:space-y-1"
    >
      <h3
        class="hidden md:block text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2"
      >
        {selectedWorkspace ? selectedWorkspace.name : 'Communauté'}
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'overview'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Settings size={18} />
        Vue d'ensemble
      </button>
      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'members'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Users size={18} />
        Membres
      </button>

      <div class="hidden md:block mt-auto pt-4 space-y-2">
        <button
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors w-full"
        >
          <Trash2 size={18} />
          Quitter la communauté
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="flex-1 bg-white/50 p-6 overflow-y-auto min-h-[300px]">
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">Vue d'ensemble</h2>

          <div class="flex items-center gap-6">
            <div class="relative flex-shrink-0">
              <div class="w-24 h-24 rounded-full overflow-hidden shadow-md">
                <GroupAvatar
                  imageMediaId={selectedWorkspace?.imageMediaId}
                  name={selectedWorkspace?.name ?? ''}
                  variant="community"
                  size="lg"
                />
              </div>
              <label
                class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center cursor-pointer hover:bg-amber-600 transition-colors shadow"
                title="Changer l'image"
              >
                {#if imageUploading}
                  <Loader size={14} class="animate-spin" />
                {:else}
                  <Upload size={14} />
                {/if}
                <input
                  type="file"
                  accept="image/*"
                  class="sr-only"
                  disabled={imageUploading}
                  onchange={handleImageFileChange}
                />
              </label>
            </div>
            <div class="flex-1 space-y-2">
              {#if imageUploadError}
                <p class="text-xs text-red-600">{imageUploadError}</p>
              {/if}
              <label class="text-xs font-bold uppercase text-text-muted" for="server-name"
                >Nom de la communauté</label
              >
              <input
                id="server-name"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50"
                value={selectedWorkspace ? selectedWorkspace.name : ''}
              />
            </div>
          </div>

          <div
            class="border border-cn-border bg-white rounded-xl p-4 shadow-sm text-sm text-text-main flex items-center gap-3"
          >
            <ShieldCheck size={24} class="text-green-500" />
            <div class="flex-1">
              <span class="font-bold block">Chiffrement E2E Actif</span>
              <span class="text-xs text-text-muted"
                >Les canaux de cette communauté utilisent Secure Group Messaging (MLS).</span
              >
            </div>
          </div>
        </div>
      {/if}

      {#if activeTab === 'members'}
        <div class="space-y-6 max-w-3xl">
          <h2 class="text-xl font-bold text-text-main">Membres</h2>
          <p class="text-sm text-text-muted">
            Gestion des membres de la communauté et de leurs rôles globaux.
          </p>

          <!-- Placer ici une liste factice ou une vraie table -->
          <div class="border border-cn-border rounded-xl bg-white overflow-hidden text-sm">
            <div class="p-4 flex items-center justify-between border-b border-cn-border bg-black/5">
              <span class="font-semibold text-text-main">1 Membre(s)</span>
              <button
                class="bg-amber-500 text-white rounded-lg px-3 py-1.5 text-xs font-bold hover:bg-amber-600 transition"
              >
                Générer une invitation
              </button>
            </div>
            <div class="p-6 text-center text-text-muted">
              Aucun membre à afficher pour le moment.
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
