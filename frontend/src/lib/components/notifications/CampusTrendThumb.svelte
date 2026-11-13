<script lang="ts">
  import { TrendingUp } from '@lucide/svelte';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { getToken } from '$lib/stores/auth';
  import { placeholderDataUrl } from '$lib/utils/mediaPlaceholder';
  import type { MediaFailureCause } from '$lib/utils/mediaErrors';
  import type { PostMediaRef } from '$lib/posts/api';
  import {
    cachedSharedPostPreview,
    fetchSharedPostPreview,
    type SharedPostPreview,
  } from '$lib/posts/sharedPostPreview';
  import { Log } from '$lib/utils/Log';

  /**
   * THE AVATAR OF A CAMPUS-TREND ROW (engagement WP-10, owner 2026-11-10): the row is not a person,
   * so it draws no actor - no "Quelqu'un", no initials disc. A post that shows a picture draws THAT
   * picture (its first one, read once the row is near the viewport, through the same cached
   * preview the shared-post bubble uses, and decrypted by `PostMedia`); a video draws its ThumbHash;
   * anything else - and everything until the picture is there - draws the trend glyph.
   *
   * `media` is the row's `meta.media`, written by the server from the post's first attachment: the
   * glyph-only row (no attachment) never reads the post at all.
   */
  interface Props {
    postId: string;
    media: 'photo' | 'video' | null;
  }

  let { postId, media }: Props = $props();

  /** What `PostMedia` reads once `ready` has gone - never drawn (durable-rules, `{#if}` teardown). */
  const NO_MEDIA: PostMediaRef = {
    type: 'image',
    mediaId: '',
    key: '',
    iv: '',
    mimeType: '',
    size: 0,
  };

  let preview = $state.raw<SharedPostPreview | null>(null);
  let isNear = $state(false);
  let failed = $state(false);
  let authToken = $state('');
  let PostMedia = $state<typeof import('$lib/components/posts/PostMedia.svelte').default | null>(
    null
  );

  $effect(() => {
    const id = postId;
    failed = false;
    if (!media || !id) {
      preview = null;
      return;
    }
    const cached = cachedSharedPostPreview(id);
    if (cached) {
      preview = cached;
      return;
    }
    if (!isNear) return;
    let cancelled = false;
    void fetchSharedPostPreview(id).then((answer) => {
      if (cancelled) return;
      if (answer.state !== 'ready') {
        Log.d('NOTIF', `campus trend ${id.slice(0, 8)}: preview ${answer.state}, the glyph stays`);
      }
      preview = answer;
    });
    return () => {
      cancelled = true;
    };
  });

  const picture = $derived(
    preview?.state === 'ready' && preview.media && !failed ? preview.media : null
  );
  const thumbHash = $derived(picture?.placeholder ? placeholderDataUrl(picture.placeholder) : null);
  const isImage = $derived(preview?.state === 'ready' && preview.mediaKind === 'image');

  // The decrypting component is loaded on demand: a glyph or video row never pays for it.
  $effect(() => {
    if (!picture || !isImage || PostMedia) return;
    let cancelled = false;
    void Promise.all([getToken(), import('$lib/components/posts/PostMedia.svelte')])
      .then(([token, mod]) => {
        if (cancelled) return;
        if (!token) {
          Log.d('NOTIF', 'campus trend: no session token for the picture, the glyph stays');
          failed = true;
          return;
        }
        authToken = token;
        PostMedia = mod.default;
      })
      .catch((error: unknown) => {
        console.error('[NOTIF] the campus trend picture component did not load', error);
        if (!cancelled) failed = true;
      });
    return () => {
      cancelled = true;
    };
  });

  function onMediaFailure(cause: MediaFailureCause) {
    Log.d(
      'NOTIF',
      `campus trend ${postId.slice(0, 8)}: picture failed (${cause}), the glyph stays`
    );
    failed = true;
  }
</script>

<span
  class="bg-cn-border/60 text-text-muted relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg"
  aria-hidden="true"
  data-notif-trend-avatar={picture ? 'picture' : 'glyph'}
  use:nearViewport={{ onnear: () => (isNear = true) }}
>
  <TrendingUp size={24} />
  {#if picture}
    <span
      class="absolute inset-0"
      style={thumbHash ? `background: center / cover no-repeat url('${thumbHash}')` : ''}
    ></span>
    {#if isImage && PostMedia && authToken}
      <span class="absolute inset-0" inert>
        <PostMedia media={picture ?? NO_MEDIA} {authToken} galleryMode onFailure={onMediaFailure} />
      </span>
    {/if}
  {/if}
</span>
