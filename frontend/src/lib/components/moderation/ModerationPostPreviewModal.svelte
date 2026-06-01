<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import PostHeader from '$lib/components/posts/PostHeader.svelte';
  import PostContent from '$lib/components/posts/PostContent.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import { getPost, type PostEntity } from '$lib/posts/api';
  import { getToken } from '$lib/stores/auth';
  import { Loader2, FileX } from '@lucide/svelte';

  interface Props {
    open: boolean;
    postId: string | null;
    onClose: () => void;
  }

  let { open, postId, onClose }: Props = $props();

  let loading = $state(false);
  let error = $state('');
  let post = $state<PostEntity | null>(null);
  let authToken = $state('');

  onMount(() => {
    void getToken()
      .then((t) => {
        authToken = t;
      })
      .catch(() => {});
  });

  $effect(() => {
    if (!open || !postId) {
      post = null;
      error = '';
      loading = false;
      return;
    }
    const id = postId;
    loading = true;
    error = '';
    post = null;
    void getPost(id)
      .then((loaded) => {
        if (open && postId === id) post = loaded;
      })
      .catch((e) => {
        if (open && postId === id) {
          error = e instanceof Error ? e.message : 'Impossible de charger la publication.';
        }
      })
      .finally(() => {
        if (open && postId === id) loading = false;
      });
  });
</script>

<Modal
  {open}
  {onClose}
  title="Publication signalée"
  maxWidth="max-w-xl"
  dismissible={!loading}
>
  <div class="overflow-y-auto min-h-0 flex-1 px-1 pb-2">
    {#if loading}
      <div class="flex flex-col items-center justify-center gap-3 py-16 text-text-muted">
        <Loader2 size={32} class="animate-spin opacity-60" />
        <p class="text-sm">Chargement…</p>
      </div>
    {:else if error}
      <div class="py-12 text-center px-4">
        <FileX size={40} class="mx-auto mb-3 text-text-muted opacity-40" />
        <p class="text-sm text-red-600">{error}</p>
      </div>
    {:else if post}
      <Card class="overflow-hidden border-cn-border/80 shadow-sm">
        <PostHeader {post} />
        <PostContent {post} {authToken} fullContent />
      </Card>
      <p class="mt-3 text-[10px] font-mono text-text-muted/50 truncate px-1" title={post.id}>
        {post.id}
      </p>
    {/if}
  </div>
</Modal>
