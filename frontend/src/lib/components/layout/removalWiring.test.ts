/**
 * Source guard for the shell's half of a removal broadcast (2026-10-27): somebody else's removal is
 * handed to the departure election with the actor AND its committing device, and the local user's
 * own leave drops the salon without telling them they were removed. The decisions are pure and
 * tested in `memberRemoval.test.ts`; this pins that the component no unit test mounts uses them -
 * the same pattern as `communityListingTrigger.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);
const handler = (() => {
  const start = source.indexOf('onChannelMemberKicked: (event: any) =>');
  return source.slice(start, start + 4000);
})();

describe('ChatBackgroundService - a removal broadcast', () => {
  it('hands somebody else`s removal to the election, built by departureToDecide', () => {
    const ignore = handler.slice(handler.indexOf("if (outcome === 'ignore')"));
    expect(ignore.slice(0, 600)).toMatch(
      /const departure = departureToDecide\(event\);\s*if \(departure\) void commitDepartureIfElected\(channelService, departure, appendLog\);/
    );
  });

  it('decides a leave with isOwnLeave, and shows the "removed" toast only when it was not one', () => {
    expect(handler).toContain('const selfLeft = isOwnLeave(event, globalSession.userId);');
    expect(handler).toMatch(/if \(!selfLeft\) \{\s*showToast\(m\.channel_removed_from_channel\(/);
  });

  it('forgets the salon grants and the departures left to actors on sign-out', () => {
    const signOut = source.slice(source.indexOf('function handleSignedOut'));
    expect(signOut.slice(0, 1500)).toContain('salonGrants.clear();');
    expect(signOut.slice(0, 1500)).toContain('forgetDeparturesLeftToActors();');
  });

  it('decides again, on a reconnect or a return to the foreground, a removal left to its actor', () => {
    const reconnect = source.slice(source.indexOf('function handleReconnect'));
    expect(reconnect.slice(0, 600)).toContain(
      'void revisitDeparturesLeftToActors(channelService, appendLog);'
    );
  });
});
