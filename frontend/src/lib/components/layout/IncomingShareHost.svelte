<script lang="ts">
  /**
   * Asks where a share from another app goes ("Envoyer a..."), on every route.
   *
   * It drains the share the native layer left (`drainNativeShare`) when it mounts, when Android says
   * a new one is ready (`canari:incoming-share`) and when the app comes back to the foreground. The
   * picker opens only once the session is up - the PIN gate comes first. The pick is published as a
   * deep-link landing, so the conversation opens exactly as a tapped notification would, and the
   * chat page then stages the share in its composer (`incomingShare.takeFor`).
   * See `docs/wiki/frontend/sharing.md`.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import ForwardMessageModal from '$lib/components/chat/ForwardMessageModal.svelte';
  import { incomingShare } from '$lib/stores/incomingShare.svelte';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import {
    globalSession,
    globalConvs,
    globalChannels,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { chatDeepLinkRoute } from '$lib/utils/chat/notificationRouting';
  import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
  import { drainNativeShare } from '$lib/mobile/incomingShareDrain';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { Conversation } from '$lib/types';

  const pickerOpen = $derived(
    globalSession.isLoggedIn && incomingShare.pending !== null && incomingShare.target === null
  );

  /**
   * Drains one waiting share (its text and file names, no bytes); says how many items the native
   * side refused, if any. Silent when nothing waits - this runs on every return to the foreground.
   */
  async function drain(reason: string): Promise<void> {
    const result = await drainNativeShare();
    if (!result) return;
    appendLog(`[SHARE] drained on ${reason}, ${result.lost} item(s) lost`);
    if (result.lost > 0) showToast(m.share_items_lost({ count: result.lost }), 'error');
  }

  // A LANDING CAN END WITHOUT DISPLAYING ITS TARGET (abandoned, or the member went elsewhere), and
  // then nothing would ever take the share: it would sit with a destination that never opens and no
  // picker to change it. The landing ending is the fact that says so - no clock.
  $effect(() => {
    const target = incomingShare.target;
    if (target !== null && notifNav.pending !== target) incomingShare.releaseTarget();
  });

  function pick(_key: string, conversation: Conversation) {
    // The conversation ID, not the map key: a DM is keyed by its display name, and a landing names
    // the group id (`resolveConversationKey` crosses that gap on arrival).
    incomingShare.chooseTarget(conversation.id);
    notifNav.navigate(conversation.id);
    void goto(resolve(chatDeepLinkRoute(conversation.id)));
  }

  onMount(() => {
    if (!isAndroidTauriRuntime()) return;
    // Listen BEFORE the first drain: a share whose copy finishes between the two is then announced
    // to a listener rather than to nobody.
    const onShare = () => void drain('native announced a share');
    const onForeground = (e: Event) => {
      if ((e as CustomEvent<{ foreground?: boolean }>).detail?.foreground) void drain('foreground');
    };
    window.addEventListener('canari:incoming-share', onShare);
    window.addEventListener('canari:foreground', onForeground);
    void drain('mount');
    return () => {
      window.removeEventListener('canari:incoming-share', onShare);
      window.removeEventListener('canari:foreground', onForeground);
    };
  });
</script>

<ForwardMessageModal
  open={pickerOpen}
  variant="share"
  conversations={[...globalConvs.conversations.entries()]}
  currentUserId={globalSession.userId}
  channelWorkspaces={globalChannels.channelWorkspaces}
  onClose={() => incomingShare.cancel()}
  onSelect={pick}
/>
