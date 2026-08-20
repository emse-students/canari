<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    getReviewerAccess,
    listReviewerDocuments,
    associationLogoSrc,
    type ReviewerDocumentGroup,
    type ReviewerDocument,
  } from '$lib/associations/api';
  import {
    importRawAesKey,
    unpackEncryptedBlob,
    decryptDocument,
  } from '$lib/associations/vaultCrypto';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import { FolderOpen, ChevronDown, Download, FileText, Building2 } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { getLocale } from '$lib/paraglide/runtime';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state('');
  let groups = $state<ReviewerDocumentGroup[]>([]);
  let query = $state('');
  const expanded = new SvelteSet<string>();
  let downloadingId = $state<string | null>(null);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        documents: g.documents.filter(
          (d) => d.name.toLowerCase().includes(q) || g.associationName.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.associationName.toLowerCase().includes(q) || g.documents.length > 0);
  });

  const totalDocs = $derived(groups.reduce((sum, g) => sum + g.documents.length, 0));

  function toggle(assocId: string) {
    if (expanded.has(assocId)) expanded.delete(assocId);
    else expanded.add(assocId);
  }

  /** Preserves the file extension when the display name was renamed without one. */
  function downloadName(doc: ReviewerDocument): string {
    if (/\.[^./\\]+$/.test(doc.name)) return doc.name;
    const ext = doc.originalFilename?.match(/\.[^./\\]+$/)?.[0];
    return ext ? `${doc.name}${ext}` : doc.name;
  }

  function formatBytes(bytes: number): string {
    const en = getLocale() === 'en';
    if (bytes < 1024) return `${bytes} ${en ? 'B' : 'o'}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${en ? 'KB' : 'Ko'}`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / 1024 / 1024).toFixed(1)} ${en ? 'MB' : 'Mo'}`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ${en ? 'GB' : 'Go'}`;
  }

  async function handleDownload(doc: ReviewerDocument) {
    downloadingId = doc.id;
    error = '';
    try {
      console.log(`[Reviewer] Downloading: ${doc.id}`);
      const mediaBase = socialUrl() || '';
      const res = await apiFetch(`${mediaBase}/api/media/${encodeURIComponent(doc.mediaId)}`);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const packed = await res.arrayBuffer();

      const { iv, ciphertext } = unpackEncryptedBlob(packed);
      const key = await importRawAesKey(doc.cek);
      const plaintext = await decryptDocument(key, iv, ciphertext);

      await downloadDecryptedFile(new Blob([plaintext], { type: doc.mimeType }), downloadName(doc));
      console.log(`[Reviewer] Download complete: ${doc.name}`);
    } catch (e) {
      console.error('[Reviewer] Download error:', e);
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      downloadingId = null;
    }
  }

  async function load() {
    loading = true;
    error = '';
    try {
      groups = await listReviewerDocuments();
      // Auto-expand when only a handful of associations are present.
      if (groups.length <= 3) for (const g of groups) expanded.add(g.associationId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    let allowed = false;
    try {
      allowed = await getReviewerAccess();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      void goto('/dashboard', { replaceState: true });
      return;
    }
    ready = true;
    void load();
  });
</script>

{#if ready}
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
    <header class="flex items-start gap-3">
      <span
        class="bg-cn-yellow/20 text-cn-dark flex h-11 w-11 items-center justify-center rounded-2xl"
      >
        <FolderOpen size={22} />
      </span>
      <div>
        <h1 class="text-text-main text-xl font-extrabold tracking-tight">
          {m.reviewer_docs_title()}
        </h1>
        <p class="text-text-muted mt-0.5 text-sm">{m.reviewer_docs_subtitle()}</p>
      </div>
    </header>

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {:else if groups.length === 0}
      <p
        class="border-cn-border text-text-muted rounded-2xl border bg-(--cn-surface) px-4 py-10 text-center text-sm"
      >
        {m.reviewer_docs_empty()}
      </p>
    {:else}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          bind:value={query}
          placeholder={m.reviewer_docs_search_placeholder()}
          aria-label={m.reviewer_docs_search_placeholder()}
          class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full max-w-sm rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        />
        <span class="text-text-muted text-xs font-semibold">
          {m.reviewer_docs_count_label({ assos: groups.length, docs: totalDocs })}
        </span>
      </div>

      <div class="space-y-3">
        {#each filtered as group (group.associationId)}
          {@const logo = associationLogoSrc(group.logoUrl)}
          {@const isOpen = expanded.has(group.associationId)}
          <div class="border-cn-border overflow-hidden rounded-2xl border bg-(--cn-surface)">
            <button
              type="button"
              onclick={() => toggle(group.associationId)}
              aria-expanded={isOpen}
              class="hover:bg-cn-bg/40 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
            >
              {#if logo}
                <img
                  src={logo}
                  alt=""
                  class="border-cn-border h-9 w-9 shrink-0 rounded-lg border object-cover"
                />
              {:else}
                <span
                  class="bg-cn-yellow/15 text-cn-dark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                >
                  <Building2 size={18} />
                </span>
              {/if}
              <span class="min-w-0 flex-1">
                <span class="text-text-main block truncate text-sm font-bold">
                  {group.associationName}
                </span>
                <span class="text-text-muted block text-xs">
                  {m.reviewer_docs_group_count({ count: group.documents.length })}
                </span>
              </span>
              <ChevronDown
                size={18}
                class="text-text-muted shrink-0 transition-transform {isOpen ? 'rotate-180' : ''}"
              />
            </button>

            {#if isOpen}
              <ul class="divide-cn-border/70 border-cn-border/70 divide-y border-t">
                {#each group.documents as doc (doc.id)}
                  <li class="flex items-center gap-3 px-4 py-3">
                    <FileText size={18} class="text-text-muted shrink-0" />
                    <div class="min-w-0 flex-1">
                      <p class="text-text-main truncate text-sm font-semibold">{doc.name}</p>
                      <p class="text-text-muted text-xs">
                        {formatBytes(doc.size)} · {doc.mimeType}
                      </p>
                    </div>
                    <button
                      type="button"
                      onclick={() => handleDownload(doc)}
                      disabled={downloadingId === doc.id}
                      title={m.reviewer_docs_download_title()}
                      class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center justify-center rounded-xl border bg-(--cn-surface) p-2 transition-colors disabled:opacity-40"
                    >
                      {#if downloadingId === doc.id}
                        <div
                          class="border-cn-yellow h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
                        ></div>
                      {:else}
                        <Download size={15} />
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
