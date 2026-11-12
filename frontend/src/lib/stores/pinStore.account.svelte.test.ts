// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '$lib/utils/accountLocalKeys';
import { clearUserLocally } from '$lib/stores/user';
import {
  applyPin,
  forgetConversationPins,
  isMessagePinned,
  pinnedMessageIds,
} from './pinStore.svelte';

/**
 * THE PIN REGISTER IS PER ACCOUNT (found 2026-11-09, review of #3177). It was stored under
 * `canari_pins_<conversation>` alone: two accounts on one install sharing a conversation shared one
 * register, and the account deletion's sweep never named it. Each test uses its own conversation id,
 * because the module caches every register it has read.
 */
describe('the pin register belongs to one account', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    setCurrentUserId(null);
    vi.restoreAllMocks();
  });

  it('a pin is stored under the signed-in account, and another account on the install does not see it', () => {
    setCurrentUserId('alice');
    applyPin('conv_shared', 'msg_1', true, 10);
    expect(localStorage.getItem(ACCOUNT_KEY.conversationPins('alice', 'conv_shared'))).toContain(
      'msg_1'
    );
    expect(localStorage.getItem('canari_pins_conv_shared')).toBeNull();

    setCurrentUserId('bob');
    expect(isMessagePinned('conv_shared', 'msg_1')).toBe(false);
    expect(pinnedMessageIds('conv_shared')).toEqual([]);

    setCurrentUserId('alice');
    expect(isMessagePinned('conv_shared', 'msg_1')).toBe(true);
  });

  it('the account deletion sweeps the register, and only its own', () => {
    setCurrentUserId('alice');
    applyPin('conv_swept', 'msg_1', true, 10);
    setCurrentUserId('bob');
    applyPin('conv_swept', 'msg_2', true, 10);

    const swept = accountLocalStorageKeysIn(localStorage, 'alice');
    expect(swept).toContain(ACCOUNT_KEY.conversationPins('alice', 'conv_swept'));
    expect(swept).not.toContain(ACCOUNT_KEY.conversationPins('bob', 'conv_swept'));
  });

  it('a legacy register is moved once, to the first account that reads the conversation', () => {
    localStorage.setItem(
      'canari_pins_conv_legacy',
      JSON.stringify({ msg_1: { pinned: true, at: 5 } })
    );
    setCurrentUserId('alice');
    expect(isMessagePinned('conv_legacy', 'msg_1')).toBe(true);
    expect(localStorage.getItem('canari_pins_conv_legacy')).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.conversationPins('alice', 'conv_legacy'))).toContain(
      'msg_1'
    );

    setCurrentUserId('bob');
    expect(isMessagePinned('conv_legacy', 'msg_1')).toBe(false);
  });

  it('a register of its own wins over a legacy one, which is then left untouched', () => {
    localStorage.setItem(
      ACCOUNT_KEY.conversationPins('alice', 'conv_both'),
      JSON.stringify({ msg_own: { pinned: true, at: 7 } })
    );
    localStorage.setItem(
      'canari_pins_conv_both',
      JSON.stringify({ msg_legacy: { pinned: true, at: 5 } })
    );
    setCurrentUserId('alice');
    expect(pinnedMessageIds('conv_both')).toEqual(['msg_own']);
    expect(localStorage.getItem('canari_pins_conv_both')).not.toBeNull();
  });

  it('a sign-out forgets the registers of the account leaving, stored and in memory, and no other', () => {
    setCurrentUserId('bob');
    applyPin('conv_signout', 'msg_bob', true, 10);
    setCurrentUserId('alice');
    applyPin('conv_signout', 'msg_alice', true, 10);
    expect(isMessagePinned('conv_signout', 'msg_alice')).toBe(true);

    clearUserLocally();
    expect(localStorage.getItem(ACCOUNT_KEY.conversationPins('alice', 'conv_signout'))).toBeNull();
    expect(
      localStorage.getItem(ACCOUNT_KEY.conversationPins('bob', 'conv_signout'))
    ).not.toBeNull();

    // Back as alice: the memory copy went with the stored one, so nothing of it comes back.
    setCurrentUserId('alice');
    expect(isMessagePinned('conv_signout', 'msg_alice')).toBe(false);
  });

  it('forgetting an account (the deletion path) clears its memory copy as well as its stored one', () => {
    setCurrentUserId('alice');
    applyPin('conv_forget', 'msg_1', true, 10);
    forgetConversationPins('alice');
    expect(localStorage.getItem(ACCOUNT_KEY.conversationPins('alice', 'conv_forget'))).toBeNull();
    expect(isMessagePinned('conv_forget', 'msg_1')).toBe(false);
  });

  it('a legacy register whose copy cannot be written is read, and kept for the next try', () => {
    localStorage.setItem(
      'canari_pins_conv_quota',
      JSON.stringify({ msg_1: { pinned: true, at: 5 } })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    setCurrentUserId('alice');
    expect(isMessagePinned('conv_quota', 'msg_1')).toBe(true);
    setItem.mockRestore();
    expect(localStorage.getItem('canari_pins_conv_quota')).not.toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.conversationPins('alice', 'conv_quota'))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not moved, kept where it is'));
  });

  it('with nobody signed in, a pin is held in memory and written nowhere', () => {
    applyPin('conv_nobody', 'msg_1', true, 10);
    expect(isMessagePinned('conv_nobody', 'msg_1')).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});
