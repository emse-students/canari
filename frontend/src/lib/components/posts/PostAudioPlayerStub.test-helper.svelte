<script lang="ts">
  /** Stands in for `VoiceMessagePlayer`: says what it was handed. */
  let {
    src,
    mimeType = '',
    loudness = null,
  }: { src: string; mimeType?: string; loudness?: unknown; onDownload?: () => void } = $props();
</script>

<div
  data-audio-player-stub
  data-src={src}
  data-mime-type={mimeType}
  data-loudness={JSON.stringify(loudness)}
></div>
