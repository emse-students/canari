<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getVaultKey,
    listDocuments,
    createDocument,
    getDocumentDetail,
    deleteDocument,
    getAssociationNotesCiphertext,
    saveAssociationNotesCiphertext,
    type AssociationDocument,
    type DocumentVaultStats,
  } from '$lib/associations/api';
  import {
    deriveDocumentCek,
    deriveDocumentCekWithPassword,
    encryptDocument,
    decryptDocument,
    packEncryptedBlob,
    unpackEncryptedBlob,
    randomPwSalt,
    parseVaultMarkers,
    buildVaultMarkers,
    encryptVaultNote,
    decryptVaultNote,
  } from '$lib/associations/vaultCrypto';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import { FileUp, Trash2, Download, FileText, Lock, NotebookPen } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { portal } from '$lib/actions/portal';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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

  // Upload dialog: a chosen file awaits an optional protection password.
  let pendingFile = $state<File | null>(null);
  let uploadModalOpen = $state(false);
  let uploadPassword = $state('');

  // Download password prompt for a protected document.
  let pwPromptDoc = $state<AssociationDocument | null>(null);
  let pwPromptValue = $state('');
  let pwPromptError = $state('');
  let pwPromptBusy = $state(false);

  /** True when the document is password-protected (has a `[pw:…]` marker). */
  function isProtected(doc: AssociationDocument): boolean {
    return parseVaultMarkers(doc.description).pwSalt !== null;
  }

  // Shared admin notepad, encrypted with the vault key (invisible to the server).
  let noteText = $state('');
  let noteLoading = $state(true);
  let noteSaving = $state(false);
  let noteError = $state('');
  let noteSaved = $state(false);

  async function loadNote() {
    noteLoading = true;
    noteError = '';
    try {
      const [vaultKeyHex, ciphertext] = await Promise.all([
        getVaultKey(associationId),
        getAssociationNotesCiphertext(associationId),
      ]);
      noteText = await decryptVaultNote(vaultKeyHex, ciphertext);
    } catch (e) {
      console.error('[Vault] Failed to load notepad:', e);
      noteError = m.asso_doc_load_notepad_error();
    } finally {
      noteLoading = false;
    }
  }

  async function saveNote() {
    noteSaving = true;
    noteError = '';
    noteSaved = false;
    try {
      const vaultKeyHex = await getVaultKey(associationId);
      const ciphertext = await encryptVaultNote(vaultKeyHex, noteText);
      await saveAssociationNotesCiphertext(associationId, ciphertext);
      noteSaved = true;
      setTimeout(() => (noteSaved = false), 2000);
    } catch (e) {
      console.error('[Vault] Failed to save notepad:', e);
      noteError = m.asso_doc_save_notepad_error();
    } finally {
      noteSaving = false;
    }
  }

  onMount(() => {
    void load();
    void loadNote();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      stats = await listDocuments(associationId);
      console.log(
        `[Vault] ${stats.documents.length} documents, ${stats.usedBytes}/${stats.quotaBytes} bytes`
      );
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // Defer the actual upload: the dialog lets the user attach an optional password.
    pendingFile = file;
    uploadPassword = '';
    uploadError = '';
    uploadModalOpen = true;
  }

  async function confirmUpload() {
    if (!pendingFile) return;
    const file = pendingFile;
    const password = uploadPassword.trim();
    uploadModalOpen = false;
    pendingFile = null;
    uploadPassword = '';
    await uploadFile(file, password || undefined);
  }

  async function uploadFile(file: File, password?: string) {
    uploading = true;
    uploadError = '';
    try {
      console.log(`[Vault] Uploading: ${file.name} (${file.size} bytes)`);

      // Check for name collision before upload
      const duplicate = stats?.documents.find(
        (d) => d.name.toLowerCase() === file.name.toLowerCase()
      );
      if (duplicate) {
        const replace = await showConfirm(
          m.asso_doc_confirm_replace({ name: duplicate.name }),
          { confirmLabel: m.asso_doc_replace_button() }
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
      // A password-protected document derives its CEK from the vault key AND the
      // password (never sent), so even a BDE super-admin with the vault key cannot
      // open it. The PBKDF2 salt is stored in the description, the password is not.
      const pwSalt = password ? randomPwSalt() : null;
      const cek = password
        ? await deriveDocumentCekWithPassword(vaultKeyHex, cekSalt, password, pwSalt as string)
        : await deriveDocumentCek(vaultKeyHex, cekSalt);

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
        throw new Error(`Media upload error: ${uploadRes.status} ${msg}`);
      }
      const { mediaId } = (await uploadRes.json()) as { mediaId: string };
      console.log(`[Vault] Encrypted blob uploaded: ${mediaId}`);

      // Store the CEK salt (and password salt, if any) in the description so the
      // download flow can rebuild the key. Format: "[s:<salt>]" optionally "[pw:<salt>]".
      const doc = await createDocument(associationId, {
        name: file.name,
        description: buildVaultMarkers(cekSalt, pwSalt),
        mediaId,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      });
      console.log(`[Vault] Document saved: ${doc.id}`);
      stats = await listDocuments(associationId);
    } catch (e: unknown) {
      console.error('[Vault] Erreur upload:', e);
      if (e && typeof e === 'object' && 'status' in e) {
        uploadError = `Error ${(e as { status: number }).status} - check available storage space`;
      } else {
        uploadError = e instanceof Error ? e.message : 'Upload error';
      }
    } finally {
      uploading = false;
    }
  }

  function handleDownload(doc: AssociationDocument) {
    if (isProtected(doc)) {
      // Protected: ask for the password, then decrypt in submitPwPrompt.
      pwPromptDoc = doc;
      pwPromptValue = '';
      pwPromptError = '';
      return;
    }
    downloadingId = doc.id;
    performDownload(doc)
      .catch((e) => {
        console.error('[Vault] Download error:', e);
        error = e instanceof Error ? e.message : 'Download error';
      })
      .finally(() => {
        downloadingId = null;
      });
  }

  /**
   * Fetches, decrypts and saves a document. Throws on any failure (caller handles
   * the error). For a protected document, a wrong password surfaces as an AES-GCM
   * authentication failure thrown by `decryptDocument`.
   */
  async function performDownload(doc: AssociationDocument, password?: string) {
    console.log(`[Vault] Downloading: ${doc.id}`);

    const detail = await getDocumentDetail(associationId, doc.id);
    if (!detail.mediaId) throw new Error('mediaId missing in document metadata');

    const { cekSalt, pwSalt } = parseVaultMarkers(detail.description);
    if (!cekSalt) throw new Error('Encryption salt not found - document is corrupt');

    const vaultKeyHex = await getVaultKey(associationId);
    const cek =
      pwSalt && password
        ? await deriveDocumentCekWithPassword(vaultKeyHex, cekSalt, password, pwSalt)
        : await deriveDocumentCek(vaultKeyHex, cekSalt);

    const mediaBase = socialUrl() || '';
    const dlRes = await apiFetch(`${mediaBase}/api/media/${encodeURIComponent(detail.mediaId)}`);
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
    const packed = await dlRes.arrayBuffer();

    const { iv, ciphertext } = unpackEncryptedBlob(packed);
    const plaintext = await decryptDocument(cek, iv, ciphertext);

    const blob = new Blob([plaintext], { type: detail.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = detail.name;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[Vault] Download complete: ${detail.name}`);
  }

  async function submitPwPrompt() {
    if (!pwPromptDoc || !pwPromptValue) return;
    pwPromptBusy = true;
    pwPromptError = '';
    try {
      await performDownload(pwPromptDoc, pwPromptValue);
      pwPromptDoc = null;
      pwPromptValue = '';
    } catch (e) {
      console.error('[Vault] Failed to decrypt protected document:', e);
      pwPromptError = m.asso_doc_pw_incorrect();
    } finally {
      pwPromptBusy = false;
    }
  }

  async function handleDelete(doc: AssociationDocument) {
    if (!await showConfirm(m.asso_doc_confirm_delete({ name: doc.name }), { danger: true, confirmLabel: m.common_delete_button() })) return;
    try {
      await deleteDocument(associationId, doc.id);
      console.log(`[Vault] Document deleted: ${doc.id}`);
      stats = await listDocuments(associationId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_delete_error();
    }
  }

  function formatBytes(bytes: number): string {
    const en = getLocale() === 'en';
    if (bytes < 1024) return `${bytes} ${en ? 'B' : 'o'}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${en ? 'KB' : 'Ko'}`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} ${en ? 'MB' : 'Mo'}`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ${en ? 'GB' : 'Go'}`;
  }
</script>

<div class="space-y-5">
  <!-- Shared admin notepad (vault-encrypted) -->
  <div class="space-y-2 rounded-2xl border border-cn-border/70 bg-cn-bg/40 p-4">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-bold text-text-main flex items-center gap-1.5">
        <NotebookPen size={16} class="text-cn-dark" />
        {m.asso_doc_notepad_title()}
      </p>
      <span class="text-[11px] text-text-muted">{m.asso_doc_notepad_badge()}</span>
    </div>
    {#if noteLoading}
      <p class="text-xs text-text-muted py-3">{m.asso_doc_decrypting()}</p>
    {:else}
      <MarkdownComposerField
        bind:value={noteText}
        placeholder={m.asso_doc_notepad_placeholder()}
        minHeight="120px"
      />
      <div class="flex items-center justify-end gap-3 pt-1">
        {#if noteError}
          <span class="text-xs text-red-600 mr-auto">{noteError}</span>
        {:else if noteSaved}
          <span class="text-xs text-green-600 mr-auto">{m.asso_doc_saved_label()}</span>
        {/if}
        <button
          type="button"
          onclick={saveNote}
          disabled={noteSaving}
          class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          {noteSaving ? m.common_saving_label() : m.common_save_button()}
        </button>
      </div>
    {/if}
  </div>

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
        <span>{m.asso_doc_quota_label()}</span>
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
        class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 shadow-sm"
      >
        <FileUp size={16} />
        {uploading ? m.asso_doc_upload_encrypting() : m.asso_doc_upload_button()}
      </button>
      {#if uploadError}
        <p class="text-sm text-red-600 mt-2">{uploadError}</p>
      {/if}
    </div>

    <!-- Document list -->
    {#if stats.documents.length === 0}
      <p class="text-sm text-text-muted text-center py-8">{m.asso_doc_no_documents()}</p>
    {:else}
      <ul class="space-y-2">
        {#each stats.documents as doc (doc.id)}
          <li
            class="flex items-center gap-3 rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3"
          >
            <FileText size={18} class="shrink-0 text-text-muted" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-text-main text-sm truncate flex items-center gap-1.5">
                {#if isProtected(doc)}
                  <Lock size={13} class="shrink-0 text-amber-600" />
                {/if}
                <span class="truncate">{doc.name}</span>
              </p>
              <p class="text-xs text-text-muted">
                {formatBytes(doc.size)} · {doc.mimeType}{#if isProtected(doc)} · {m.asso_doc_protected_suffix()}{/if}
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onclick={() => handleDownload(doc)}
                disabled={downloadingId === doc.id}
                title={m.asso_doc_download_title()}
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
                title={m.common_delete_button()}
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

{#if uploadModalOpen}
  <div use:portal>
    <div
      class="fixed inset-0 z-[280] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && (uploadModalOpen = false)}
    >
      <div
        class="w-full max-w-md rounded-t-3xl sm:rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-xl p-6 space-y-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
      >
        <h3 id="upload-modal-title" class="text-lg font-bold text-text-main">{m.asso_doc_upload_modal_title()}</h3>
        <p class="text-sm text-text-muted truncate">{pendingFile?.name}</p>
        <div class="space-y-1.5">
          <Input
            label={m.asso_doc_password_label()}
            type="password"
            bind:value={uploadPassword}
            placeholder={m.asso_doc_password_placeholder()}
          />
          <p class="text-xs text-text-muted">
            {m.asso_doc_password_warning()}
          </p>
        </div>
        <div class="flex flex-wrap gap-2 justify-end pt-1">
          <button
            type="button"
            onclick={() => (uploadModalOpen = false)}
            class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg"
          >
            {m.common_cancel_button()}
          </button>
          <button
            type="button"
            onclick={confirmUpload}
            class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover"
          >
            {m.asso_doc_upload_confirm_button()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if pwPromptDoc}
  <div use:portal>
    <div
      class="fixed inset-0 z-[280] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && !pwPromptBusy && (pwPromptDoc = null)}
    >
      <div
        class="w-full max-w-md rounded-t-3xl sm:rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-xl p-6 space-y-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-prompt-title"
      >
        <h3 id="pw-prompt-title" class="text-lg font-bold text-text-main flex items-center gap-2">
          <Lock size={18} class="text-amber-600" />
          {m.asso_doc_protected_title()}
        </h3>
        <p class="text-sm text-text-muted truncate">{pwPromptDoc.name}</p>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void submitPwPrompt();
          }}
          class="space-y-3"
        >
          <Input label={m.common_password_label()} type="password" bind:value={pwPromptValue} />
          {#if pwPromptError}
            <p class="text-sm text-red-600">{pwPromptError}</p>
          {/if}
          <div class="flex flex-wrap gap-2 justify-end pt-1">
            <button
              type="button"
              onclick={() => (pwPromptDoc = null)}
              disabled={pwPromptBusy}
              class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg disabled:opacity-50"
            >
              {m.common_cancel_button()}
            </button>
            <button
              type="submit"
              disabled={pwPromptBusy || !pwPromptValue}
              class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
            >
              {pwPromptBusy ? m.asso_doc_decrypting() : m.asso_doc_open_button()}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}
