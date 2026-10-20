<script lang="ts">
  /**
   * THE CALL, MINIMISED: a slim bar at the top of the app while the rest of it stays usable -
   * "Bob - 02:13", a tap returns to the full screen, and mute and hang-up are on the bar itself.
   *
   * It is a ROW OF THE ROOT LAYOUT'S BANNER COLUMN, in flow, so it pushes the page down rather than
   * painting over its header, and the column publishes its height (`--app-banner-height`) to every
   * fixed card that follows the top of the content. That is also why its controls cannot end up
   * under anything native: on iOS the tab bar and the conversation's glass pieces are native views
   * drawn ABOVE the WebView at the web layout's rects, and the old bottom-right card sat exactly
   * under the tab bar with its hang-up unreachable (CALL-IOS-HANGUP). Nothing native is drawn above
   * the content's top edge, and the glass pieces follow their web twins down when this row appears.
   *
   * It decides for itself whether to render, like its neighbours: only while a call is up AND
   * minimised (`callView`). The full screen, with the call's one audio sink, is `CallOverlay`.
   */
  import { Mic, MicOff, Phone, PhoneOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { callView } from '$lib/stores/callView.svelte';
  import { useCallModel } from '$lib/composables/useCallModel.svelte';
  import { callMicNotice, callStatusText } from '$lib/utils/callStatusText';
  import { resolveCallPeers } from '$lib/utils/chat/callPeers';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { appendLog } from '$lib/utils/sessionLog';
  import type { CallService } from '$lib/services/CallService';

  const service = $derived(globalSession.callService as CallService | null);
  const call = useCallModel(() => service);

  const visible = $derived(!!service && call.callState !== 'idle' && !callView.showsFullScreen);
  const isIncoming = $derived(call.callState === 'incoming');

  const peerName = $derived.by(() => {
    if (!visible || !service) return '';
    const peers = resolveCallPeers({
      userId: globalSession.userId || currentUserId() || '',
      callGroupId: service.currentGroupId,
      conversations: globalConvs.conversations.values(),
      incomingCallerId: service.incomingCallerId,
      nameOf: getUserDisplayNameSync,
    });
    return peers[0]?.displayName || m.call_label();
  });
  const statusText = $derived(callStatusText(call.kind, call.duration));
  /** An OS holding a microphone, either side, in place of the timer while it lasts. */
  const micNotice = $derived(
    callMicNotice(call.kind, call.localMicSuspended, call.peerMicSuspended, peerName)
  );

  // THE BAR IS NEVER UNDER A LAYER (CALL-BAR-COVERED, Mi 9T and iPhone, 2026-10-19): with the
  // new-post composer or its camera open, the bar sat under that layer and its hang-up could not be
  // reached. `data-call-bar` lifts the banner column to `--z-call` and pushes every covering
  // surface's top inset below it (app.css, "A MINIMISED CALL IS ABOVE EVERY LAYER").
  $effect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-call-bar', visible);
    if (visible) appendLog('[Call] top bar up - above every covering layer');
    return () => root.removeAttribute('data-call-bar');
  });

  function expand() {
    appendLog('[Call] banner tapped - back to the full screen');
    callView.expand();
  }

  function hangUp() {
    appendLog(`[Call] ${isIncoming ? 'declined' : 'hung up'} from the top banner`);
    service?.endCall();
  }

  function accept() {
    if (!service) return;
    appendLog('[Call] accepted from the top banner');
    callView.expand();
    void service.acceptCall(service.currentGroupId ?? '', service.currentCallId ?? '');
  }
</script>

{#if visible}
  <div
    class="flex items-center gap-1 px-2 py-1 text-white {call.callState === 'ended'
      ? 'bg-neutral-700'
      : 'bg-emerald-700'}"
    data-testid="call-banner"
    role="region"
    aria-label={m.call_banner_region_label()}
  >
    <button
      type="button"
      class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-white/10"
      aria-label={m.call_banner_return_label({ name: peerName })}
      onclick={expand}
    >
      <span class="relative flex size-2.5 shrink-0" aria-hidden="true">
        {#if call.kind !== 'live' && call.kind !== 'ended'}
          <span class="absolute inset-0 rounded-full bg-white/70 motion-safe:animate-ping"></span>
        {/if}
        <span class="relative size-2.5 rounded-full bg-white"></span>
      </span>
      <span class="min-w-0 truncate text-sm font-semibold">{peerName}</span>
      <span class="shrink-0 text-sm text-white/85" aria-hidden="true">·</span>
      <span
        class="text-sm text-white/85 tabular-nums {micNotice ? 'min-w-0 truncate' : 'shrink-0'}"
        data-testid="call-banner-status"
        >{callView.audioBlocked ? m.call_tap_to_hear() : (micNotice ?? statusText)}</span
      >
      <span class="ml-auto hidden shrink-0 text-xs text-white/75 sm:inline"
        >{m.call_banner_return_hint()}</span
      >
    </button>
    {#if isIncoming}
      <button
        type="button"
        class="ui-icon-button shrink-0 rounded-full bg-red-500 text-white hover:bg-red-400"
        aria-label={m.call_decline_incoming_label()}
        onclick={hangUp}
      >
        <PhoneOff size={20} />
      </button>
      <button
        type="button"
        class="ui-icon-button shrink-0 rounded-full bg-white text-emerald-700 hover:bg-white/90"
        aria-label={m.call_accept_incoming_label()}
        onclick={accept}
      >
        <Phone size={20} class="fill-current" />
      </button>
    {:else if call.callState !== 'ended'}
      <button
        type="button"
        class="ui-icon-button shrink-0 rounded-full {call.isMuted
          ? 'bg-white text-emerald-700'
          : 'text-white hover:bg-white/15'}"
        aria-label={call.isMuted ? m.call_unmute_label() : m.call_mute_label()}
        aria-pressed={call.isMuted}
        onclick={() => service?.toggleMute()}
      >
        {#if call.isMuted}<MicOff size={20} />{:else}<Mic size={20} />{/if}
      </button>
      <button
        type="button"
        class="ui-icon-button shrink-0 rounded-full bg-red-500 text-white hover:bg-red-400"
        aria-label={m.call_hang_up_label()}
        onclick={hangUp}
      >
        <PhoneOff size={20} />
      </button>
    {/if}
  </div>
{/if}
