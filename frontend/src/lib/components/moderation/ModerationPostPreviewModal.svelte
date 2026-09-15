<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import PostHeader from '$lib/components/posts/PostHeader.svelte';
  import PostContent from '$lib/components/posts/PostContent.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import { getPost, type PostEntity } from '$lib/posts/api';
  import { getToken } from '$lib/stores/auth';
  import { LoaderCircle, FileX, Copy } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { copyId } from '$lib/utils/copyId';

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
      .catch((e: unknown) => {
        // The media in the preview needs this token; without it the images stay blank, and a
        // blank preview with a silent console is a moderation decision taken on nothing.
        Log.d('moderationPreview.getToken failed', e);
      });
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
        Log.d('moderationPreview.getPost failed', e);
        if (open && postId === id) {
          error = m.moderation_load_post_error();
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
      {@const postId = post.id}
      <Card class="border-cn-border/80 overflow-hidden shadow-sm">
        <PostHeader {post} />
        <PostContent {post} {authToken} fullContent />
      </Card>
      <!--
        SHORTENED AND COPIED, like the list this modal opens from. Rendered whole under `truncate`
        the id was cut at whatever the modal happened to be wide, and the hidden half could be
        neither read nor selected; the `title` that carried it does not exist on a touch screen.
      -->
      <button
        type="button"
        onclick={() => void copyId(postId)}
        class="text-text-muted/50 hover:text-text-muted text-2xs mt-3 flex items-center gap-1 px-1 font-mono transition-colors"
        title={m.admin_copy_id_label()}
      >
        {postId.slice(0, 8)}…
        <Copy size={10} />
      </button>
    {/if}
  </div>
</Modal>
