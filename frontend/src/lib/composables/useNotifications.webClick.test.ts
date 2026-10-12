import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A BROWSER NOTIFICATION'S CLICK ROUTES BY THE TARGET'S KIND, NOT TO `/chat` ALWAYS.
 *
 * The Tauri path already went through `chatDeepLinkRoute`; the web `Notification.onclick` sent every
 * click to `/chat`, so a salon (`channel_<uuid>`, which lives under `/communities`) opened the wrong
 * page first and only reached the right one through the landing effect's second navigation - one
 * extra Back press (2026-10-08 audit). A source guard, like its neighbours here: the composable
 * reaches the Notification constructor, which nothing in a unit environment can click.
 */
const source = readFileSync(
  join(process.cwd(), 'src/lib/composables/useNotifications.svelte.ts'),
  'utf8'
);

describe('the web notification click', () => {
  it('routes a conversation through chatDeepLinkRoute', () => {
    const click = source.slice(source.indexOf('n.onclick = async () =>'));
    const body = click.slice(0, click.indexOf('n.close();'));
    expect(body).toContain('goto(chatDeepLinkRoute(conversationId))');
    expect(body).not.toContain("goto('/chat')");
  });
});
