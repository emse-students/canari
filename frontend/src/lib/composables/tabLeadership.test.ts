import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard on what a tab does the moment leadership changes hands.
 *
 * The behaviour is not executable in a unit test - the handlers are registered inside
 * `useChatSession`, a Svelte 5 rune composable wired to the WebSocket, MLS and storage - but the
 * decision they encode is small and load-bearing: a tab that takes over must NOT keep sending from
 * the MLS state it loaded, because the leader it replaces has been advancing that ratchet on disk
 * ever since (WP-MULTITAB-1). The same technique as `session/offlineUnlock.test.ts`.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const useChatSession = read('./useChatSession.svelte.ts');
const outbox = read('../utils/chat/outbox.ts');

/** The body of a `setTabLeader*Handler(() => { … })` registration. */
function handlerBody(name: string): string {
  const start = useChatSession.indexOf(`${name}(() => {`);
  expect(start).toBeGreaterThan(-1);
  const rest = useChatSession.slice(start);
  return rest.slice(0, rest.indexOf('\n  });') + 6);
}

describe('a change of tab leadership never leaves a stale ratchet sending', () => {
  it('reloads on promotion instead of only reconnecting the WebSocket', () => {
    // Reconnecting alone would resume sending from the snapshot this tab loaded, at a generation
    // the peer has already consumed - the message reaches the server and is dropped on arrival.
    // The reload is one function, shared with a login promoted before it went live (`sessionAuth`).
    const promoted = handlerBody('setTabLeaderPromotedHandler');
    expect(promoted).toContain('reloadForPromotion(cb.log)');
    const start = useChatSession.indexOf('function reloadForPromotion(');
    expect(start).toBeGreaterThan(-1);
    const reload = useChatSession.slice(start, useChatSession.indexOf('\n  }\n', start));
    expect(reload).toContain('markPromotionReload()');
    expect(reload).toContain('window.location.reload()');
  });

  it('still reloads on demotion, so a released leader restarts read-only', () => {
    expect(handlerBody('setTabLeaderDemotedHandler')).toContain('window.location.reload()');
  });
});

describe('only the leader tab encrypts', () => {
  it('gates the outbox flush on the state authority before it can reach mlsService.sendMessage', () => {
    const start = outbox.indexOf('async function runFlush');
    expect(start).toBeGreaterThan(-1);
    const body = outbox.slice(start);
    // `refusesCommitsHere`, not the election: a leader promoted in place, its reload owed, flushes
    // nothing either (review of #3371).
    const gateAt = body.indexOf('if (refusesCommitsHere())');
    expect(gateAt).toBeGreaterThan(-1);
    // The gate has to precede every reason a flush could be attempted, offline checks included.
    expect(gateAt).toBeLessThan(body.indexOf('connectivity.isOffline'));
    expect(body.slice(gateAt)).toContain('requestLeaderOutboxFlush()');
  });
});
