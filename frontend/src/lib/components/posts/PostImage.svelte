<script lang="ts">
  import PostMedia from './PostMedia.svelte';

  interface Props {
    media: {
      mediaId: string;
      key: string;
      iv: string;
      mimeType: string;
      size: number;
      fileName?: string;
      width?: number;
      height?: number;
    };
    authToken: string;
    onOpen?: () => void;
    galleryMode?: boolean;
  }

  let { media, authToken, onOpen, galleryMode = false }: Props = $props();
</script>

<!--
  @deprecated PostImage is kept for backward compatibility.
  Use PostMedia directly for multimodal attachments.
-->
<PostMedia {media} {authToken} {onOpen} {galleryMode} />
