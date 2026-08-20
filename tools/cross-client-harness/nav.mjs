/**
 * Client-side navigation to a route, for clients that may be sitting anywhere.
 *
 * NEVER `Page.navigate` on the phone: a document load re-locks the encryption PIN and drops any
 * in-page patch a check installed, and CDP's Network domain is blind to the app's own requests
 * there anyway (`hooks.client.ts` swaps `window.fetch` for the Tauri plugin's Rust client). The
 * app's own `<a href>` goes through SvelteKit's router, which is what a user does.
 */
import { evaluate, until } from './cdp.mjs';

export async function gotoRoute(cx, route) {
  const here = await evaluate(cx, 'location.pathname');
  if (here === route) return here;
  const clicked = await evaluate(
    cx,
    `(function () {
      var a = [].filter.call(document.querySelectorAll('a[href=${JSON.stringify(route)}]'), function (e) {
        return e.getBoundingClientRect().width > 0;
      })[0];
      if (!a) return false;
      a.click();
      return true;
    })()`
  );
  if (!clicked) throw new Error(`no visible in-app link to ${route}`);
  // The action asserts its own post-condition: a click that did not navigate is not a navigation.
  await until(cx, `location.pathname === ${JSON.stringify(route)}`, 15000);
  return evaluate(cx, 'location.pathname');
}

/**
 * Opens `name`'s conversation, and is IDEMPOTENT when it is already open.
 *
 * `openConversation` looks for a visible list entry, and on the phone the conversation list is
 * still in the DOM while a conversation is open but laid out at zero width - so every element it
 * would click is filtered out and it times out with the conversation plainly on screen. That cost
 * a run: the check had opened the DM in a previous step and then refused to find it.
 *
 * The post-condition is what it should have asserted all along, and it is the same on both
 * layouts: the open pane's HEADER names the peer. Checked against the head of the pane text
 * rather than the whole of it, because a message body mentioning the peer's name is not evidence
 * that their conversation is open.
 */
export async function ensureConversation(cx, name, openConversation) {
  const header = await evaluate(
    cx,
    String.raw`(function () {
      var c = document.querySelector('.chat-composer-footer .chat-composer-editor');
      var pane = c ? c.closest('section') : null;
      return pane ? pane.innerText.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    })()`
  );
  if (header.toLowerCase().includes(name.toLowerCase())) return `already open: ${header}`;
  return openConversation(cx, name);
}
