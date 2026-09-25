/**
 * A REFUSED CREATION KEEPS THE PANEL OPEN AND SAYS WHY.
 *
 * `createNewGroup` and `startNewConversation` used to answer `void`, so this panel closed on every
 * submit: the modal shut, the sidebar was unchanged, the conversation was not there, and the only
 * trace was a console line. Now they answer a typed refusal and this component decides what to do
 * with it, which is the behaviour pinned here - the discriminators themselves are pinned in
 * `groupCreation.refusal.test.ts`.
 *
 * Mounting the SIDEBAR rather than the modal is the point. The modal has no idea whether a creation
 * worked; the decision to stay open, to keep the typed text, and to close on success all live in
 * the component that makes the call, and a test of the modal alone would assert none of them.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

// The same import-cycle break the other composable suites use: Sidebar -> mediaTouch ->
// globalChatSingleton, which calls useMessaging() at module scope and reaches back into a half-built
// module graph. Nothing in this suite goes near the singleton.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

import { flushSync, mount, unmount, tick } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { ConversationOutcome } from '$lib/utils/chat/groupCreation';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

/**
 * The panel opens with a 220 ms `fly`, and every case here closes or unmounts long before that ends.
 *
 * Svelte cancels an interrupted transition; happy-dom's `Animation.cancel()` REJECTS the animation's
 * `finished` promise, and nothing in the app ever reads it - so an interrupted intro raises an
 * unhandled `AbortError` and the run exits 1 for a reason that belongs entirely to the environment.
 * Claiming the promise is the fix. Waiting the animation out instead would put a wall clock in five
 * tests to work around one of happy-dom's.
 */
afterAll(adoptTransitionAnimations());

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** Mounts an empty sidebar whose two creation callbacks answer whatever a case hands them. */
function mountSidebar(answer: ConversationOutcome) {
  const onCreateGroup = vi.fn(async () => answer);
  const onAddContact = vi.fn(async () => answer);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      conversations: new SvelteMap<string, Conversation>(),
      selectedContact: null,
      newContactInput: '',
      newGroupInput: '',
      onContactInputChange: () => {},
      onGroupInputChange: () => {},
      onAddContact,
      onCreateGroup,
      onSelectConversation: () => {},
      currentUserId: 'me',
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return { onCreateGroup, onAddContact };
}

/** Clicks the first button whose visible text is exactly `label`. */
function clickByText(label: string): void {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button labelled "${label}"`);
  button.click();
  flushSync();
}

/** Opens the panel on its group tab and submits `name`. */
function submitGroup(name: string): void {
  clickByText(m.chat_new_discussion_label());
  document.querySelector<HTMLButtonElement>('#tab-group')!.click();
  flushSync();
  const input = document.querySelector<HTMLInputElement>('#new-group-name')!;
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  document
    .querySelector<HTMLFormElement>('#new-group-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** The panel is open exactly when its group form is in the document. */
const panelIsOpen = () => document.querySelector('#new-group-form') !== null;
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';

describe('the new-chat panel answers to the creation, not to the click', () => {
  it('stays open and renders the refusal when the creation is declined', async () => {
    const { onCreateGroup } = mountSidebar({ ok: false, reason: 'duplicate-group-name' });

    submitGroup('Equipe');
    await tick();
    flushSync();

    expect(onCreateGroup).toHaveBeenCalledWith('Equipe');
    expect(panelIsOpen()).toBe(true);
    expect(alertText()).toBe(m.chat_modal_error_duplicate_group());
  });

  it('keeps the text that was typed, so the member can read what was refused', async () => {
    mountSidebar({ ok: false, reason: 'peer-has-no-device' });

    submitGroup('Equipe');
    await tick();
    flushSync();

    expect(document.querySelector<HTMLInputElement>('#new-group-name')!.value).toBe('Equipe');
  });

  it('closes on success, because the sidebar row is the signal', async () => {
    mountSidebar({ ok: true, key: 'g-new' });

    submitGroup('Equipe');
    await tick();
    flushSync();

    expect(panelIsOpen()).toBe(false);
  });

  it('shows no refusal before one has happened', () => {
    mountSidebar({ ok: false, reason: 'creation-failed' });

    clickByText(m.chat_new_discussion_label());

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('runs one creation per submit however many times the button is pressed', async () => {
    // The creation takes seconds. Without the busy gate a second press starts a SECOND group, and
    // the member who pressed twice because nothing happened ends up with two.
    let release: (v: ConversationOutcome) => void = () => {};
    const pending = new Promise<ConversationOutcome>((resolve) => {
      release = resolve;
    });
    const onCreateGroup = vi.fn(() => pending);
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(Sidebar, {
      target,
      props: {
        conversations: new SvelteMap<string, Conversation>(),
        selectedContact: null,
        newContactInput: '',
        newGroupInput: '',
        onContactInputChange: () => {},
        onGroupInputChange: () => {},
        onAddContact: async () => ({ ok: true, key: null }) as ConversationOutcome,
        onCreateGroup,
        onSelectConversation: () => {},
        currentUserId: 'me',
      },
    });
    mounted.push(() => unmount(app));
    flushSync();

    submitGroup('Equipe');
    await tick();
    flushSync();
    // Second press, while the first is still in flight.
    document
      .querySelector<HTMLFormElement>('#new-group-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(onCreateGroup).toHaveBeenCalledTimes(1);
    release({ ok: true, key: 'g-new' });
    await pending;
  });
});
