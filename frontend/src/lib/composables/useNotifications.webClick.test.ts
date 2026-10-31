import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A BROWSER NOTIFICATION'S CLICK - AND AN INCOMING CALL'S - PUBLISH THEIR TARGET AND NOTHING MORE.
 *
 * Both used to `goto` a route after `notifNav.navigate`. In a window narrow enough for the
 * conversation to be an overlay, that navigation's `beforeNavigate` drained the overlay the landing
 * effect in `ChatBackgroundService` had just opened, so the conversation closed at once
 * (`shareLanding.ts`, 2026-10-27). The effect routes - a salon to `/communities` included. A source
 * guard, like its neighbours here: the composable reaches the Notification constructor, which
 * nothing in a unit environment can click.
 */
const source = readFileSync(
  join(process.cwd(), 'src/lib/composables/useNotifications.svelte.ts'),
  'utf8'
);

/** The text of the first handler starting at `start` after `anchor`, up to `end`. */
function handler(anchor: string, start: string, end: string): string {
  const at = source.indexOf(start, source.indexOf(anchor));
  expect(source.indexOf(anchor)).toBeGreaterThan(-1);
  expect(at).toBeGreaterThan(-1);
  const from = source.slice(at);
  return from.slice(0, from.indexOf(end));
}

describe('the web notification click', () => {
  it('publishes the conversation and never navigates itself', () => {
    const body = handler('canari-${conversationId', 'n.onclick = () =>', 'n.close();');
    expect(body).toContain('notifNav.navigate(conversationId)');
    expect(body).not.toMatch(/\bgoto\(/);
  });
});

describe('the incoming-call tap', () => {
  it('publishes the call conversation and never navigates itself', () => {
    const body = handler('notif_call_body_unknown', 'const onTap = () =>', '};');
    expect(body).toContain('notifNav.navigate(groupId)');
    expect(body).not.toMatch(/\bgoto\(/);
  });
});
