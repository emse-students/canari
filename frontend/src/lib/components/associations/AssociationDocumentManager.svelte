<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getVaultKey,
    listDocuments,
    createDocument,
    getDocumentDetail,
    deleteDocument,
    type AssociationDocument,
    type DocumentVaultStats,
  } from '$lib/associations/api';
  import {
    deriveDocumentCek,
    encryptDocument,
    decryptDocument,
    packEncryptedBlob,
    unpackEncryptedBlob,
  } from '$lib/associations/vaultCrypto';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import { FileUp, Trash2, Download, FileText } from '@lucide/svelte';

  interface Props {
    associationId: string;
  }

  const { associationId }: Props = $props();

  let stats = $state<DocumentVaultStats | null>(null);
  let loading = $state(true);
  let error = $state('');
  let uploading = $state(false);
  let uploadError = $state('');
  let downloadingId = $state<string | null>(null);

  let fileInput = $state<HTMLInputElement | undefined>(undefined);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      stats = await listDocuments(associationId);
      console.log(
        `[Vault] ${stats.documents.length} documents, ${stats.usedBytes}/${stats.quotaBytes} bytes`
      );
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur de chargement';
    } finally {
      loading = false;
    }
  }

  async function handleFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await uploadFile(file);
    (e.target as HTMLInputElement).value = '';
  }

  async function uploadFile(file: File) {
    uploading = true;
    uploadError = '';
    try {
      console.log(`[Vault] Uploading: ${file.name} (${file.size} bytes)`);

      // Check for name collision before upload
      const duplicate = stats?.documents.find(
        (d) => d.name.toLowerCase() === file.name.toLowerCase()
      );
      if (duplicate) {
        const replace = confirm(
          `Un document nommé "${duplicate.name}" existe déjà.\nVoulez-vous le remplacer ?`
        );
        if (replace) {
          await deleteDocument(associationId, duplicate.id);
          stats = await listDocuments(associationId);
        }
        // else keep both (upload with same name, server allows it after deletion)
      }

      // Fetch vault key and encrypt the file.
      // CEK salt = mediaId (known after the media upload). We upload the plaintext first
      // to get the mediaId, then re-encrypt with the final CEK. Since plaintext reaches
      // media-service only within the trusted network and is immediately replaced, this
      // is acceptable. For true zero-knowledge: use a random pre-generated salt and store it.
      //
      // Simpler and correct: use a random client-generated UUID as the CEK salt, store it
      // alongside the document. We store it in the description prefixed by "[s:<salt>]"
      // (32 hex chars, invisible to users when stripped on display).
      const vaultKeyHex = await getVaultKey(associationId);
      const cekSalt = crypto.randomUUID(); // stable, per-document identifier
      const cek = await deriveDocumentCek(vaultKeyHex, cekSalt);

      const buffer = await file.arrayBuffer();
      const { iv, ciphertext } = await encryptDocument(cek, buffer);
      const packed = packEncryptedBlob(iv, ciphertext);

      // Upload encrypted blob to media-service as multipart form data
      const mediaBase = socialUrl() || '';
      const fd = new FormData();
      fd.append('file', new Blob([packed], { type: 'application/octet-stream' }), file.name);
      const uploadRes = await apiFetch(`${mediaBase}/api/media/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!uploadRes.ok) {
        const msg = await uploadRes.text().catch(() => '');
        throw new Error(`Erreur upload média: ${uploadRes.status} ${msg}`);
      }
      const { mediaId } = (await uploadRes.json()) as { mediaId: string };
      console.log(`[Vault] Blob chiffré uploadé: ${mediaId}`);

      // Store the CEK salt in the description so we can retrieve it for decryption.
      // Format: "[s:<salt>]" - a 36-char UUID, invisible once stripped.
      const doc = await createDocument(associationId, {
        name: file.name,
        description: `[s:${cekSalt}]`,
        mediaId,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      });
      console.log(`[Vault] Document enregistré: ${doc.id}`);
      stats = await listDocuments(associationId);
    } catch (e: unknown) {
      console.error('[Vault] Erreur upload:', e);
      if (e && typeof e === 'object' && 'status' in e) {
        uploadError = `Erreur ${(e as { status: number }).status} - vérifiez l'espace disponible`;
      } else {
        uploadError = e instanceof Error ? e.message : "Erreur lors de l'upload";
      }
    } finally {
      uploading = false;
    }
  }

  async function handleDownload(doc: AssociationDocument) {
    downloadingId = doc.id;
    try {
      console.log(`[Vault] Téléchargement: ${doc.id}`);

      const detail = await getDocumentDetail(associationId, doc.id);
      if (!detail.mediaId) throw new Error('mediaId manquant dans les métadonnées');

      // Extract CEK salt from description
      const saltMatch = detail.description?.match(/^\[s:([^\]]+)\]/);
      const cekSalt = saltMatch?.[1];
      if (!cekSalt) throw new Error('Salt de chiffrement introuvable - document corrompu');

      const vaultKeyHex = await getVaultKey(associationId);
      const cek = await deriveDocumentCek(vaultKeyHex, cekSalt);

      // Download encrypted blob
      const mediaBase = socialUrl() || '';
      const dlRes = await apiFetch(`${mediaBase}/api/media/${encodeURIComponent(detail.mediaId)}`);
      if (!dlRes.ok) throw new Error(`Téléchargement échoué: ${dlRes.status}`);
      const packed = await dlRes.arrayBuffer();

      // Decrypt and trigger download
      const { iv, ciphertext } = unpackEncryptedBlob(packed);
      const plaintext = await decryptDocument(cek, iv, ciphertext);

      const blob = new Blob([plaintext], { type: detail.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = detail.name;
      a.click();
      URL.revokeObjectURL(url);
      console.log(`[Vault] Téléchargement terminé: ${detail.name}`);
    } catch (e) {
      console.error('[Vault] Erreur téléchargement:', e);
      error = e instanceof Error ? e.message : 'Erreur lors du téléchargement';
    } finally {
      downloadingId = null;
    }
  }

  async function handleDelete(doc: AssociationDocument) {
    if (!confirm(`Supprimer "${doc.name}" ? Cette action est irréversible.`)) return;
    try {
      await deleteDocument(associationId, doc.id);
      console.log(`[Vault] Document supprimé: ${doc.id}`);
      stats = await listDocuments(associationId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors de la suppression';
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Go`;
  }
</script>

<div class="space-y-5">
  {#if loading}
    <div class="flex justify-center py-10">
      <div
        class="h-7 w-7 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if stats}
    <!-- Quota bar -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-xs text-text-muted">
        <span>Espace utilisé</span>
        <span>{formatBytes(stats.usedBytes)} / {formatBytes(stats.quotaBytes)}</span>
      </div>
      <div class="h-2 rounded-full bg-cn-border/50 overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-300
            {stats.usedBytes / stats.quotaBytes > 0.9
            ? 'bg-red-500'
            : stats.usedBytes / stats.quotaBytes > 0.75
              ? 'bg-amber-500'
              : 'bg-cn-yellow'}"
          style="width: {Math.min(100, (stats.usedBytes / stats.quotaBytes) * 100).toFixed(1)}%"
        ></div>
      </div>
    </div>

    <!-- Upload button -->
    <div>
      <input
        bind:this={fileInput}
        type="file"
        class="hidden"
        onchange={handleFileChange}
        disabled={uploading}
      />
      <button
        type="button"
        onclick={() => fileInput?.click()}
        disabled={uploading}
        class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50 shadow-sm"
      >
        <FileUp size={16} />
        {uploading ? 'Chiffrement et upload…' : 'Ajouter un document'}
      </button>
      {#if uploadError}
        <p class="text-sm text-red-600 mt-2">{uploadError}</p>
      {/if}
    </div>

    <!-- Document list -->
    {#if stats.documents.length === 0}
      <p class="text-sm text-text-muted text-center py-8">Aucun document dans le coffre.</p>
    {:else}
      <ul class="space-y-2">
        {#each stats.documents as doc (doc.id)}
          <li
            class="flex items-center gap-3 rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3"
          >
            <FileText size={18} class="shrink-0 text-text-muted" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-text-main text-sm truncate">{doc.name}</p>
              <p class="text-xs text-text-muted">{formatBytes(doc.size)} · {doc.mimeType}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onclick={() => handleDownload(doc)}
                disabled={downloadingId === doc.id}
                title="Télécharger (déchiffré localement)"
                class="inline-flex items-center justify-center rounded-xl border border-cn-border bg-[var(--cn-surface)] p-2 text-text-muted hover:text-text-main disabled:opacity-40 transition-colors"
              >
                {#if downloadingId === doc.id}
                  <div
                    class="h-4 w-4 animate-spin rounded-full border-2 border-cn-yellow border-t-transparent"
                  ></div>
                {:else}
                  <Download size={15} />
                {/if}
              </button>
              <button
                type="button"
                onclick={() => handleDelete(doc)}
                title="Supprimer"
                class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
