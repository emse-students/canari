// @vitest-environment happy-dom
/**
 * "NOUVELLE DISCUSSION" IS ONE PANEL, AND IT ANSWERS TO THE CREATION, NOT TO THE CLICK.
 *
 * People are chosen first (owner, 2026-11-17): one person opens the conversation with them, several
 * open the name step, and an empty name creates an UNNAMED group. Whatever was created, a refusal
 * keeps the panel open and says why - `createNewGroup` and `startNewConversation` answer a typed
 * refusal, and this component decides what to do with it. The discriminators themselves are pinned
 * in `groupCreation.refusal.test.ts`.
 *
 * Mounting the SIDEBAR rather than the modal is the point. The modal has no idea whether a creation
 * worked; the decision to stay open, to keep the choice, and to close on success all live in the
 * component that makes the call, and a test of the modal alone would assert none of them.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

// The same import-cycle break the other composable suites use: Sidebar -> mediaTouch ->
// globalChatSingleton, which calls useMessaging() at module scope and reaches back into a half-built
// module graph. Nothing in this suite goes near the singleton.
vi.mock('$lib/stores/globalChatSingleton.svelte', async () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: (await import('./globalChannelsStub')).globalChannelsStub(),
  globalNotifs: {},
}));

// The rows draw no picture here: an avatar asks the network, and this suite is about the panel.
vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

// Names are seeded below; a profile is never fetched in this suite.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async () => null,
}));

import { flushSync, mount, unmount, tick } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { ConversationOutcome } from '$lib/utils/chat/groupCreation';
import Sidebar from './Sidebar.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { m } from '$lib/paraglide/messages';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

const mounted: (() => void)[] = [];

/**
 * The panel opens with a 220 ms `fly`, and every case here closes or unmounts long before that ends.
 * happy-dom's `Animation.cancel()` REJECTS the animation's `finished` promise, which nothing in the
 * app reads; claiming it keeps an environment artefact from failing the run.
 */
afterAll(adoptTransitionAnimations());

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** A 1:1 row with `peer`, so the panel offers them among the recent conversations. */
function dmRow(peer: string, at: number): Conversation {
  return {
    id: `g-${peer}`,
    name: `me::${peer}`,
    contactName: peer,
    conversationType: 'direct',
    directPeerId: peer,
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    unreadCount: 0,
    lastMessageAt: at,
  } as Conversation;
}

/** Mounts a sidebar holding 1:1s with Alice and Bob, whose two callbacks answer what a case says. */
function mountSidebar(answer: ConversationOutcome | Promise<ConversationOutcome>) {
  seedUserDisplayName('alice', 'Alice Martin', 'Alice');
  seedUserDisplayName('bob', 'Bob Durand', 'Bob');
  const conversations = new SvelteMap<string, Conversation>([
    ['g-alice', dmRow('alice', 2)],
    ['g-bob', dmRow('bob', 1)],
  ]);
  const onCreateGroup = vi.fn((_name: string, _ids: string[]) => Promise.resolve(answer));
  const onAddContact = vi.fn((_id: string) => Promise.resolve(answer));
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Sidebar, {
    target,
    props: {
      conversations,
      selectedContact: null,
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

/** The first button whose visible text is exactly `label`. */
function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button labelled "${label}"`);
  return button;
}

function click(label: string): void {
  buttonByText(label).click();
  flushSync();
}

/** Opens the panel from the sidebar header's "+". */
function openPanel(): void {
  document
    .querySelector<HTMLButtonElement>(`[aria-label="${m.chat_new_discussion_label()}"]`)!
    .click();
  flushSync();
}

/** Opens the panel and chooses `names` among the recent conversations. */
function choose(...names: string[]): void {
  openPanel();
  for (const name of names) click(name);
}

const nameField = () => document.querySelector<HTMLInputElement>('#new-group-name');
const submitName = () =>
  document
    .querySelector<HTMLFormElement>('#new-group-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const panelIsOpen = () => document.querySelector('#new-chat-search') !== null;
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';

async function settle(): Promise<void> {
  await tick();
  flushSync();
}

describe('one "Nouvelle discussion" panel', () => {
  it('keeps the chips row in its place when the first person is chosen, so the list never moves', () => {
    mountSidebar({ ok: true, key: 'g-alice' });
    openPanel();
    const slot = () => document.querySelector<HTMLElement>('[data-testid="new-chat-chips-slot"]')!;
    const before = slot().className;
    const hint = slot().textContent?.trim();
    expect(hint).toBe(m.chat_modal_choose_people_hint());
    expect(before).toContain('h-10');

    click('Alice Martin');

    // The same box, the same fixed height: only its content changed.
    expect(slot().className).toBe(before);
    expect(slot().querySelector('[data-testid="new-chat-chips"]')?.textContent).toContain(
      'Alice Martin'
    );
    expect(slot().textContent).not.toContain(m.chat_modal_choose_people_hint());
    // A line that scrolls, never one that wraps into a second row.
    expect(slot().querySelector('ul')!.className).toContain('flex-nowrap');
    expect(slot().querySelector('ul')!.className).toContain('overflow-x-auto');
  });

  it('opens the conversation with the ONE person chosen', async () => {
    const { onAddContact, onCreateGroup } = mountSidebar({ ok: true, key: 'g-alice' });
    choose('Alice Martin');
    click(m.chat_modal_start_discussion_button());
    await settle();

    expect(onAddContact).toHaveBeenCalledWith('alice');
    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(panelIsOpen()).toBe(false);
  });

  it('asks for a name once SEVERAL are chosen, suggesting their first names greyed', () => {
    mountSidebar({ ok: true, key: 'g-new' });
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));

    const field = nameField()!;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(m.group_default_name_two({ first: 'Alice', second: 'Bob' }));
  });

  it('creates an UNNAMED group when the suggestion is kept', async () => {
    const { onCreateGroup } = mountSidebar({ ok: true, key: 'g-new' });
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));
    submitName();
    await settle();

    expect(onCreateGroup).toHaveBeenCalledWith('', ['alice', 'bob']);
    expect(panelIsOpen()).toBe(false);
  });

  it('creates a named group when a name is typed', async () => {
    const { onCreateGroup } = mountSidebar({ ok: true, key: 'g-new' });
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));
    const field = nameField()!;
    field.value = '  Equipe  ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    submitName();
    await settle();

    expect(onCreateGroup).toHaveBeenCalledWith('Equipe', ['alice', 'bob']);
  });

  it('removes a person by their chip, and the action follows the count', async () => {
    const { onAddContact } = mountSidebar({ ok: true, key: 'g-alice' });
    choose('Alice Martin', 'Bob Durand');
    document
      .querySelector<HTMLButtonElement>(
        `[aria-label="${m.chat_modal_remove_person_label({ name: 'Bob Durand' })}"]`
      )!
      .click();
    flushSync();
    click(m.chat_modal_start_discussion_button());
    await settle();

    expect(onAddContact).toHaveBeenCalledWith('alice');
  });
});

describe('the panel answers to the creation, not to the click', () => {
  it('stays open, keeps the name typed and renders the refusal when a group is declined', async () => {
    mountSidebar({ ok: false, reason: 'duplicate-group-name' });
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));
    const field = nameField()!;
    field.value = 'Equipe';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    submitName();
    await settle();

    expect(panelIsOpen()).toBe(true);
    expect(nameField()!.value).toBe('Equipe');
    expect(alertText()).toBe(m.chat_modal_error_duplicate_group());
  });

  it('stays open on a refused 1:1 and keeps the person chosen', async () => {
    mountSidebar({ ok: false, reason: 'peer-has-no-device' });
    choose('Alice Martin');
    click(m.chat_modal_start_discussion_button());
    await settle();

    expect(panelIsOpen()).toBe(true);
    expect(alertText()).toBe(m.chat_modal_error_peer_has_no_device());
    expect(document.querySelector('[data-testid="new-chat-chips"]')?.textContent).toContain(
      'Alice Martin'
    );
  });

  it('leaves no group refusal on the main panel once the name step is closed', async () => {
    mountSidebar({ ok: false, reason: 'duplicate-group-name' });
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));
    submitName();
    await settle();
    expect(alertText()).toBe(m.chat_modal_error_duplicate_group());

    // The name step's own close control (its dialog is the second one on screen).
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const nameDialog = dialogs[dialogs.length - 1];
    nameDialog
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.common_close_label()}"]`)!
      .click();
    flushSync();
    await settle();

    expect(nameField()).toBeNull();
    expect(panelIsOpen()).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows no refusal before one has happened', () => {
    mountSidebar({ ok: false, reason: 'creation-failed' });
    openPanel();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('runs one creation per submit however many times it is pressed', async () => {
    // The creation takes seconds. Without the busy gate a second press starts a SECOND group, and
    // the member who pressed twice because nothing happened ends up with two.
    let release: (v: ConversationOutcome) => void = () => {};
    const pending = new Promise<ConversationOutcome>((resolve) => {
      release = resolve;
    });
    const { onCreateGroup } = mountSidebar(pending);
    choose('Alice Martin', 'Bob Durand');
    click(m.chat_modal_create_group_with_button({ count: 2 }));
    submitName();
    await settle();
    submitName();
    await settle();

    expect(onCreateGroup).toHaveBeenCalledTimes(1);
    release({ ok: true, key: 'g-new' });
    await pending;
  });
});
