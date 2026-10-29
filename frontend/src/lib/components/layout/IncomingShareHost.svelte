<script lang="ts">
  /**
   * Asks where a share from another app goes ("Envoyer a..."), on every route.
   *
   * It drains the share the native layer left (`drainNativeShare`) when it mounts, when the native
   * side says a new one is ready (`canari:incoming-share` - Android's MainActivity, and on iOS
   * `canari_ios.mm` once it has carried the Share Extension's share out of the App Group) and when
   * the app comes back to the foreground (`canari:foreground`, Android; iOS imports and announces
   * on its own activation). The
   * picker opens only once the session is up - the PIN gate comes first. The pick is published as a
   * deep-link landing, so the conversation opens exactly as a tapped notification would, and the
   * chat page then stages the share in its composer (`incomingShare.takeFor`).
   *
   * It also keeps the phone's share-sheet SUGGESTIONS (lot S5: Android shortcuts, iOS intent
   * donations) in line with the conversation list (`syncShareTargets`), and opens the picker on the
   * suggestion the member picked there - only when this account holds that conversation.
   * See `docs/wiki/frontend/sharing.md`.
   */
  import { onMount } from 'svelte';
  import ForwardMessageModal from '$lib/components/chat/ForwardMessageModal.svelte';
  import { incomingShare } from '$lib/stores/incomingShare.svelte';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import {
    globalSession,
    globalConvs,
    globalChannels,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { landShareOn } from '$lib/sharing/shareLanding';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import { drainNativeShare } from '$lib/mobile/incomingShareDrain';
  import { syncShareTargets } from '$lib/sharing/shareTargets';
  import { suggestionIfHeld } from '$lib/sharing/shareDestinations';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { Conversation } from '$lib/types';

  const pickerOpen = $derived(
    globalSession.isLoggedIn && incomingShare.pending !== null && incomingShare.target === null
  );

  /** The suggestion the member picked in the share sheet, if any - a hint, not yet checked. */
  const suggested = $derived(incomingShare.pending?.suggested ?? null);

  /**
   * The suggestion, ONLY if the signed-in account holds that conversation: a shortcut published by
   * an earlier account (or for a conversation since left) must preselect nothing.
   */
  const preselectedId = $derived(suggestionIfHeld(suggested, globalConvs.conversations.values()));

  // Says once per share, while the picker is up, whether its suggestion was kept or ignored.
  let toldSuggestion: string | null = null;
  $effect(() => {
    if (!pickerOpen || suggested === null) return;
    const verdict = `${suggested}:${preselectedId !== null}`;
    if (verdict === toldSuggestion) return;
    toldSuggestion = verdict;
    appendLog(
      preselectedId !== null
        ? `[SHARE] the suggestion ${suggested.slice(0, 16)} is preselected`
        : `[SHARE] the suggestion ${suggested.slice(0, 16)} is not a conversation of this account - ignored`
    );
  });

  // The share sheet's suggestions follow the conversation list, the setting and the session.
  $effect(() => {
    // Phone apps only (Android shortcuts, iOS intent donations): elsewhere nothing is read, so
    // nothing re-runs this.
    if (!isMobileTauriRuntime()) return;
    syncShareTargets({
      enabled: settings.shareSuggestionsEnabled,
      signedIn: globalSession.isLoggedIn,
      conversationsReady: globalConvs.conversationSourcesSettled,
      conversations: () => globalConvs.conversations.entries(),
      currentUserId: globalSession.userId,
      workspaces: () => globalChannels.channelWorkspaces,
    });
  });

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
    incomingShare.chooseTarget(conversation.id);
    landShareOn(conversation.id);
  }

  onMount(() => {
    if (!isMobileTauriRuntime()) return;
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
  {preselectedId}
/>
