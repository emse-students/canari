// @vitest-environment happy-dom
/**
 * A CALL THAT NEVER CONNECTED OFFERS THE CALL AGAIN (2026-11-22): its record row carries a
 * "Rappeler" button, drawn only on a `not-connected` record and only where the conversation can
 * place a call (`onCallBack` given).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope } from '$lib/envelope';
import type { CallEndReason } from '$lib/proto/codec';
import { m } from '$lib/paraglide/messages';

afterEach(() => {
  document.body.innerHTML = '';
});

function row(outcome: CallEndReason | undefined, onCallBack?: () => void) {
  const content = serializeEnvelope({
    kind: 'system',
    text: 'record',
    callEvent: {
      callId: 'c1',
      starterId: 'u-other',
      startedAt: 1,
      endedAt: 2,
      ...(outcome ? { outcome } : {}),
    },
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'call-c1',
      senderId: 'system',
      currentUserId: 'u-me',
      content,
      timestamp: new Date(),
      isOwn: false,
      isSystem: true,
      onCallBack,
    },
  });
  flushSync();
  const button = [...target.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.chat_system_call_back())
  );
  return { app, button };
}

describe('the call-back button of a call record', () => {
  it('is drawn on a not-connected record, and a tap places the call', () => {
    const onCallBack = vi.fn();
    const { app, button } = row('not-connected', onCallBack);
    expect(button).toBeDefined();
    button!.click();
    expect(onCallBack).toHaveBeenCalledTimes(1);
    unmount(app);
  });

  it('is not drawn where no call can be placed, nor on any other record', () => {
    for (const outcome of [undefined, 'not-answered', 'declined'] as const) {
      const { app, button } = row(outcome, vi.fn());
      expect(button).toBeUndefined();
      unmount(app);
    }
    const { app, button } = row('not-connected');
    expect(button).toBeUndefined();
    unmount(app);
  });
});
