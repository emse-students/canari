import { readFileSync } from 'node:fs';

/**
 * HOW `ChatBackgroundService` HANDS THE TAB CHANNEL TO `tabReadRelay` - a guard on the wiring, since
 * mounting the service drags in the whole session. What the router DOES with the role, the account
 * and the reading predicate is `readSync.devices.test.ts`; this pins that the service gives it the
 * real ones, in the right order, once.
 */
const source = readFileSync('src/lib/components/layout/ChatBackgroundService.svelte', 'utf8');
const start = source.indexOf('function applyTabMessageEvent(');
const body = source.slice(start, source.indexOf('\n  }\n', start));

describe('ChatBackgroundService - the tab channel wiring', () => {
  it('drops another account first, then routes the read half once, before anything else', () => {
    const gate = body.indexOf('if (!tabEventIsAddressedHere(event, me)) return;');
    const route = body.indexOf('routeTabReadEvent(event, {');
    const composed = body.indexOf("event.type === 'own_message_composed'");
    expect(gate).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(gate);
    expect(composed).toBeGreaterThan(route);
    expect(body.split('routeTabReadEvent(').length - 1).toBe(1);
  });

  it("hands the router this tab's role and the READING predicate, never the bare selection", () => {
    const route = body.slice(body.indexOf('routeTabReadEvent(event, {'));
    expect(route).toContain('isLeader: globalSession.isTabLeader,');
    expect(route).toContain(
      'isReading: (key) => isReadingConversationNow(key, globalConvs.selectedContact),'
    );
  });
});
