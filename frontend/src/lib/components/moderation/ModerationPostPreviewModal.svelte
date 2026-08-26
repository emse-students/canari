<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import PostHeader from '$lib/components/posts/PostHeader.svelte';
  import PostContent from '$lib/components/posts/PostContent.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import { getPost, type PostEntity } from '$lib/posts/api';
  import { getToken } from '$lib/stores/auth';
  import { LoaderCircle, FileX } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

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
          error = e instanceof Error ? e.message : m.moderation_load_post_error();
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
  title={m.moderation_reported_post_title()}
  maxWidth="max-w-xl"
  dismissible={!loading}
>
  <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
    {#if loading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-3 py-16">
        <LoaderCircle size={32} class="animate-spin opacity-60" />
        <p class="text-sm">{m.common_loading_label()}</p>
      </div>
    {:else if error}
      <div class="px-4 py-12 text-center">
        <FileX size={40} class="text-text-muted mx-auto mb-3 opacity-40" />
        <p class="text-red-err text-sm">{error}</p>
      </div>
    {:else if post}
      <Card class="border-cn-border/80 overflow-hidden shadow-sm">
        <PostHeader {post} />
        <PostContent {post} {authToken} fullContent />
      </Card>
      <p class="text-text-muted/50 mt-3 truncate px-1 font-mono text-[10px]" title={post.id}>
        {post.id}
      </p>
    {/if}
  </div>
</Modal>
