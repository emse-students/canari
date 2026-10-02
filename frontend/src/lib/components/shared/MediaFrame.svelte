<!--
  @component
  The box a picture, a GIF or a video holds BEFORE it arrives - and keeps when it does.

  Its size is a function of what the MESSAGE declared (`width` / `height`), or for an old message of
  what this device measured the first time it drew it (`measureKey`), never of the bytes on screen.
  The skeleton, the failure and the media are all CHILDREN of the one frame, so none of them can be a
  different size than the others: that difference is what moved a row when its media landed.
  [media-frame](../../../../../docs/wiki/frontend/media-frame.md)
-->
<script lang="ts" module>
  /** What the frame hands its child. */
  export interface MediaFrameApi {
    /**
     * Give it to the `<img>`'s `load` or the `<video>`'s `loadedmetadata`. It reads the natural size
     * and, ONLY when the message declared none, files it so this row never shifts again.
     */
    onLoad: (event: Event) => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import {
    mediaFrameStyle,
    resolveMediaSize,
    validMediaSize,
    type MediaFrameSizing,
    type MediaSize,
  } from '$lib/utils/mediaFrame';
  import { measuredMediaSize, recordMeasuredMediaSize } from '$lib/utils/mediaSizeCache';

  interface Props {
    /** Width the sender declared, in px. Absent on an old message. */
    width?: number;
    /** Height the sender declared, in px. Absent on an old message. */
    height?: number;
    /** What an old message's measurement is filed under: its `mediaId`, or a GIF's URL. */
    measureKey?: string;
    /** `fill`: width from `class`, height from the ratio. `intrinsic`: the medium's own size, scaled down. */
    sizing?: MediaFrameSizing;
    /** Ratio drawn while no size is known. */
    fallbackAspect?: number;
    /** `intrinsic` only: the tallest the frame may be, as a CSS length. */
    maxHeight?: string;
    /** Classes for the frame: its width (`fill`), its corners, its surface. */
    class?: string;
    /** `span` where the frame sits in phrasing content - a GIF inside a message's `<p>`. */
    tag?: 'div' | 'span';
    children: Snippet<[MediaFrameApi]>;
  }

  let {
    width,
    height,
    measureKey,
    sizing = 'fill',
    fallbackAspect,
    maxHeight,
    class: className = '',
    tag = 'div',
    children,
  }: Props = $props();

  /** This mount's own measurement - the cache answers for the NEXT mount of the row. */
  let measuredNow = $state<MediaSize | null>(null);

  const declared = $derived(validMediaSize(width, height));
  const size = $derived(
    resolveMediaSize({ width, height }, measuredNow ?? measuredMediaSize(measureKey))
  );
  const style = $derived(mediaFrameStyle({ size, sizing, fallbackAspect, maxHeight }));

  function onLoad(event: Event): void {
    if (declared) return;
    const el = event.currentTarget;
    const natural =
      el instanceof HTMLVideoElement
        ? validMediaSize(el.videoWidth, el.videoHeight)
        : el instanceof HTMLImageElement
          ? validMediaSize(el.naturalWidth, el.naturalHeight)
          : null;
    if (!natural) {
      Log.d('MediaFrame', 'loaded medium reported no natural size - keeping the fallback box');
      return;
    }
    // THE ONE SHIFT AN OLD MESSAGE PAYS, and the reason it is paid only once per device.
    if (!size || size.width !== natural.width || size.height !== natural.height) {
      Log.d(
        'MediaFrame',
        `undeclared medium took its measured size ${natural.width}x${natural.height}`
      );
    }
    measuredNow = natural;
    if (measureKey) recordMeasuredMediaSize(measureKey, natural.width, natural.height);
  }
</script>

<svelte:element
  this={tag}
  class="relative block overflow-hidden {className}"
  {style}
  data-media-frame={sizing}
  data-media-size={size ? `${size.width}x${size.height}` : 'fallback'}
>
  {@render children({ onLoad })}
</svelte:element>
