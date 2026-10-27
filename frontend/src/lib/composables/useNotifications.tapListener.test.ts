import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE NOTIFICATION-TAP LISTENER IS REGISTERED ONCE PER SESSION, NOT ONCE PER NOTIFICATION.
 *
 * It used to be registered inside `sendSystemNotification`, immediately after the post, closing
 * over that one `conversationId`. Nothing ever removed one. So a session that had notified about
 * ten messages held ten live listeners, every one of them fired on every tap, and every one of them
 * ran the same diagnostic - one tap, ten identical warnings, on a path that cannot route anything
 * on Android in the first place. A leak and a noise multiplier from a single line, and noise is
 * never acceptable: a line its reader learns to skip is the one that hides the next defect.
 *
 * Registering once means the callback cannot close over a conversation, so the mapping moved to a
 * table keyed by the notification id - the only value that crosses the OS boundary at all.
 *
 * WHY A SOURCE GUARD. Same reasoning as `useNotifications.androidBody.test.ts`: the composable
 * reaches the plugin, the global chat singleton and `$app/navigation`, and what has to be pinned is
 * a structural property of the call graph rather than a value any assertion could read back. The
 * defect is a listener that exists more than once, which nothing observable counts.
 */
const source = readFileSync(
  join(process.cwd(), 'src/lib/composables/useNotifications.svelte.ts'),
  'utf8'
);

/** The file with its imports and comment lines removed, so a count reflects code and not prose. */
const code = source
  .split('\n')
  .filter((line) => !/^\s*(\*|\/\/|import\b)/.test(line) && !/^\s*onAction,$/.test(line))
  .join('\n');

describe('the notification tap listener is armed once and routed by a table', () => {
  it('registers in exactly one place', () => {
    // THE CAST IS THE PROBE, not the identifier: `onAction` also appears in the warning text that
    // explains a plugin build without it, and counting bare mentions made this guard fail the
    // moment that message was written. What has to stay unique is the act of registering.
    expect([...code.matchAll(/onAction as unknown as/g)]).toHaveLength(1);
    // ...and it must not happen from the post path, which is where the per-notification leak was.
    const post = code.slice(code.indexOf('async function sendSystemNotification'));
    expect(post).not.toMatch(/onAction as unknown as/);
  });

  it('latches, so a second post does not add a second listener', () => {
    const fn = /function armNotificationTapListener\(\)[\s\S]*?\n {2}\}/.exec(source);
    expect(fn).not.toBeNull();
    const body = fn![0];
    const guard = body.indexOf('if (notifTapListenerArmed) return;');
    // The early return has to come before the registration, or the latch is decorative.
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('onAction'));
    expect(body).toMatch(/notifTapListenerArmed = true;/);
  });

  it('records the target before arming, so the first tap is already routable', () => {
    // The post path does exactly two things: remember what this id means, then arm. Arming first
    // would leave a window in which a tap resolves to nothing for the very first notification.
    expect(code).toMatch(/notifTargetsById\.set\([^\n]*\n\s*armNotificationTapListener\(\);/);
  });

  it('says the identity is missing once per session rather than once per tap', () => {
    expect(code).toMatch(
      /if \(!notifIdentityMissingAnnounced\) \{\s*\n\s*notifIdentityMissingAnnounced = true;/
    );
  });

  it('publishes the target and never navigates itself (the landing effect routes)', () => {
    // A tap used to `goto` the target's route as well. On a layout where the conversation is an
    // overlay, that navigation's `beforeNavigate` drained the overlay the landing effect had just
    // opened (`shareLanding.ts`, 2026-10-27). The effect routes a channel to `/communities` itself.
    expect(code).toMatch(/notifNav\.navigate\(target\)/);
    expect(code).not.toMatch(/\bgoto\(/);
  });
});
