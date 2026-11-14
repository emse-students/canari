import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MessageHandlerDeps } from '$lib/mls-client/messagePipeline/deps';
import type { ChatSessionCallbacks } from './sessionTypes';

/**
 * The twelve server-event callbacks the session forwards to the message pipeline are declared ONCE,
 * on `MessageHandlerDeps`, and `ChatSessionCallbacks` picks them. They were written out twice
 * (two near-identical 60-line blocks, one with `any` for two of them), so a field added to one
 * event reached whichever copy its author was looking at. These assertions are compile-time:
 * `svelte-check` fails the build if either side stops being the other's type.
 */
describe('ChatSessionCallbacks reuses the pipeline event callbacks', () => {
  it('has the same type for each shared callback', () => {
    expectTypeOf<ChatSessionCallbacks['onChannelMemberJoined']>().toEqualTypeOf<
      MessageHandlerDeps['onChannelMemberJoined']
    >();
    expectTypeOf<ChatSessionCallbacks['onChannelMemberKicked']>().toEqualTypeOf<
      MessageHandlerDeps['onChannelMemberKicked']
    >();
    expectTypeOf<ChatSessionCallbacks['onChannelRemovalReleased']>().toEqualTypeOf<
      MessageHandlerDeps['onChannelRemovalReleased']
    >();
    expectTypeOf<ChatSessionCallbacks['onChannelUpdated']>().toEqualTypeOf<
      MessageHandlerDeps['onChannelUpdated']
    >();
    expectTypeOf<ChatSessionCallbacks['onWorkspaceUpdated']>().toEqualTypeOf<
      MessageHandlerDeps['onWorkspaceUpdated']
    >();
    expectTypeOf<ChatSessionCallbacks['onWorkspaceRoleChanged']>().toEqualTypeOf<
      MessageHandlerDeps['onWorkspaceRoleChanged']
    >();
    expectTypeOf<ChatSessionCallbacks['onReadStateAdvanced']>().toEqualTypeOf<
      MessageHandlerDeps['onReadStateAdvanced']
    >();
    expect(true).toBe(true);
  });
});
