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

      const blob = new Blob([plaintext], { type: doc.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(doc);
      a.click();
      URL.revokeObjectURL(url);
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
  <div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6">
    <header class="flex items-start gap-3">
      <span
        class="flex h-11 w-11 items-center justify-center rounded-2xl bg-cn-yellow/20 text-cn-dark"
      >
        <FolderOpen size={22} />
      </span>
      <div>
        <h1 class="text-xl font-extrabold text-text-main tracking-tight">
          {m.reviewer_docs_title()}
        </h1>
        <p class="text-sm text-text-muted mt-0.5">{m.reviewer_docs_subtitle()}</p>
      </div>
    </header>

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
        ></div>
      </div>
    {:else if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {:else if groups.length === 0}
      <p
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] px-4 py-10 text-center text-sm text-text-muted"
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
          class="w-full max-w-sm rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        />
        <span class="text-xs font-semibold text-text-muted">
          {m.reviewer_docs_count_label({ assos: groups.length, docs: totalDocs })}
        </span>
      </div>

      <div class="space-y-3">
        {#each filtered as group (group.associationId)}
          {@const logo = associationLogoSrc(group.logoUrl)}
          {@const isOpen = expanded.has(group.associationId)}
          <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] overflow-hidden">
            <button
              type="button"
              onclick={() => toggle(group.associationId)}
              aria-expanded={isOpen}
              class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-cn-bg/40 transition-colors"
            >
              {#if logo}
                <img
                  src={logo}
                  alt=""
                  class="h-9 w-9 shrink-0 rounded-lg object-cover border border-cn-border"
                />
              {:else}
                <span
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cn-yellow/15 text-cn-dark"
                >
                  <Building2 size={18} />
                </span>
              {/if}
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-bold text-text-main">
                  {group.associationName}
                </span>
                <span class="block text-xs text-text-muted">
                  {m.reviewer_docs_group_count({ count: group.documents.length })}
                </span>
              </span>
              <ChevronDown
                size={18}
                class="shrink-0 text-text-muted transition-transform {isOpen ? 'rotate-180' : ''}"
              />
            </button>

            {#if isOpen}
              <ul class="divide-y divide-cn-border/70 border-t border-cn-border/70">
                {#each group.documents as doc (doc.id)}
                  <li class="flex items-center gap-3 px-4 py-3">
                    <FileText size={18} class="shrink-0 text-text-muted" />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-semibold text-text-main">{doc.name}</p>
                      <p class="text-xs text-text-muted">
                        {formatBytes(doc.size)} · {doc.mimeType}
                      </p>
                    </div>
                    <button
                      type="button"
                      onclick={() => handleDownload(doc)}
                      disabled={downloadingId === doc.id}
                      title={m.reviewer_docs_download_title()}
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
