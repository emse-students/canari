<script lang="ts">
  import { ImageOff } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { gifImageGate } from '$lib/utils/chat/gifImageGate';

  /**
   * ONE PICKER THUMBNAIL, DOWNLOADED WHEN THE GATE SAYS SO.
   *
   * The tile around it is already its final size (`GifGrid` lays it out from the declared
   * dimensions), so this only decides WHEN the bytes are asked for: it waits for a slot in
   * `gifImageGate`, loads, gives the slot back on `load` or `error`, and retries ONCE after a pause
   * (the relay answers 503 `busy` when it is saturated, and a second ask a moment later is the
   * answer to that, not a loop). A tile that is unmounted before its turn leaves the queue and never
   * touches the network. Past the retry the tile says so with an icon rather than staying blank.
   */
  interface Props {
    src: string;
    width: number;
    height: number;
    /** The frame's own load callback, so it can drop its placeholder tone. */
    onLoad: (event: Event) => void;
  }

  let { src, width, height, onLoad }: Props = $props();

  /** Pause before the single retry. A pacing, not a correctness rule: a refusal is retried once. */
  const RETRY_DELAY_MS = 800;

  /** The URL handed to the `<img>`, set only once the gate granted a slot. */
  let granted = $state('');
  let failed = $state(false);

  // Plain bookkeeping of the download in progress: nothing renders from it.
  let ticket: ReturnType<typeof gifImageGate.acquire> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let alive = false;

  function giveBack() {
    ticket?.release();
    ticket = null;
  }

  function start(url: string) {
    const mine = gifImageGate.acquire();
    ticket = mine;
    void mine.granted.then(() => {
      if (alive && ticket === mine) granted = url;
    });
  }

  function settle(ok: boolean) {
    giveBack();
    if (ok || !alive) return;
    attempts++;
    if (attempts > 1) {
      Log.d('GifTile', 'thumbnail failed twice, left as is');
      failed = true;
      return;
    }
    Log.d('GifTile', 'thumbnail failed, one retry');
    granted = '';
    const url = src;
    timer = setTimeout(() => start(url), RETRY_DELAY_MS);
  }

  $effect(() => {
    const url = src;
    if (!url) return;
    alive = true;
    attempts = 0;
    failed = false;
    granted = '';
    start(url);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      timer = null;
      giveBack();
    };
  });
</script>

{#if failed}
  <div class="text-text-muted flex h-full w-full items-center justify-center" aria-hidden="true">
    <ImageOff size={18} />
  </div>
{:else if granted}
  <img
    src={granted}
    alt=""
    {width}
    {height}
    decoding="async"
    onload={(event) => {
      settle(true);
      onLoad(event);
    }}
    onerror={() => settle(false)}
    class="h-full w-full object-cover"
  />
{/if}
