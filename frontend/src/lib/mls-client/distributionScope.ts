/**
 * WHICH ROSTER A GRAINE DISTRIBUTION GROUP BELONGS TO.
 *
 * A community has one group whose roster is every member. A PRIVATE salon has its own, whose roster
 * is the people who may open it - which is what makes a private salon's guarantee cryptographic
 * rather than merely the server declining to serve its ciphertext. A public salon has none, on
 * purpose: its audience IS the community, so the community's group is already the right roster and
 * a second one would be the same people at a higher commit rate.
 *
 * The two live side by side in every map on the client, so they need ONE key, and it is built here
 * rather than concatenated at each call site - a key spelled twice is a key that will one day be
 * spelled differently, and the two halves of a lookup would silently stop meeting.
 *
 * The server-side twin is `apps/social-service/src/channels/distribution-group.client.ts`, and the
 * protocol is `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * A distribution group's roster, named.
 *
 * A channel scope carries its `workspaceId` too, and not for convenience: seeds are stored and
 * mirrored per community, so every consumer of a frame that arrives on a salon's group still needs
 * to know which community it belongs to. Deriving it from a map at that point would make the frame
 * handler depend on a channel-to-community registration that may not have happened yet.
 */
export type DistributionScope =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'channel'; workspaceId: string; channelId: string };

/** The community `workspaceId`, as a scope. */
export function workspaceScope(workspaceId: string): DistributionScope {
  return { kind: 'workspace', workspaceId };
}

/** The PRIVATE salon `channelId` of `workspaceId`, as a scope. */
export function channelScope(workspaceId: string, channelId: string): DistributionScope {
  return { kind: 'channel', workspaceId, channelId };
}

/**
 * The scope's key in any map, and the ONE place it is spelled.
 *
 * A community id and a channel id are both uuids drawn from the same space, so the prefix is what
 * keeps a salon's entry from colliding with a community's - not a theoretical collision, but the
 * ordinary case of a lookup asking the wrong question and getting a plausible answer.
 */
export function scopeKey(scope: DistributionScope): string {
  return scope.kind === 'workspace' ? `w:${scope.workspaceId}` : `c:${scope.channelId}`;
}

/** The scope as a log line names it - short ids, because every one of these lines is a debug line. */
export function scopeLabel(scope: DistributionScope): string {
  return scope.kind === 'workspace'
    ? `community ${scope.workspaceId.slice(0, 8)}`
    : `salon ${scope.channelId.slice(0, 8)} of ${scope.workspaceId.slice(0, 8)}`;
}

/** True when both name the same roster. */
export function sameScope(a: DistributionScope, b: DistributionScope): boolean {
  return scopeKey(a) === scopeKey(b);
}
