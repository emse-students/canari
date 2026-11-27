import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeEnvelope } from '$lib/envelope';
import type { StoredMessage } from '$lib/db/types';
import type { HeldConversation } from '$lib/utils/chat/heldConversations';
import type { ChannelSidebarWorkspace } from '$lib/composables/useChannelWorkspaces.svelte';
import type { Association, AssociationCalendarFeedEvent } from '$lib/associations/api';
import type { Form } from '$lib/forms/api';
import { settingsSearchIndex } from '$lib/settings/settingsSections';
import { m } from '$lib/paraglide/messages';
import { LocalMessageIndex, discardLocalMessageIndex } from './localMessageIndex';
import {
  associationsProvider,
  communitiesProvider,
  discussionsProvider,
  eventsProvider,
  eventsWindow,
  formsProvider,
  peopleProvider,
  postSearchHit,
  settingsProvider,
} from './providers';
import type { PostEntity } from '$lib/posts/api';

/** One test per section: what it reads, what it ranks first, where a row leads. */
afterEach(() => discardLocalMessageIndex('test teardown'));

describe('Personnes', () => {
  it('asks the directory with the words and keeps the order and count of the server', async () => {
    const searchDirectory = vi.fn(async () => ({
      total: 12,
      users: [
        {
          id: 'u-1',
          displayName: 'Camille Dupont',
          promo: 2026,
          formation: 'ICM',
          campus: null,
          cursus: [{ formation: 'ICM', promo: 2026 }],
          posts: [],
          bio: null,
        },
      ],
    }));
    const answer = await peopleProvider({ searchDirectory } as never).search({
      query: ' camille ',
      limit: 3,
    });
    expect(searchDirectory).toHaveBeenCalledWith({ q: 'camille', limit: 3 });
    expect(answer.total).toBe(12);
    expect(answer.hits[0]).toMatchObject({
      title: 'Camille Dupont',
      href: '/profile/u-1',
      avatarUserId: 'u-1',
    });
    expect(answer.hits[0].subtitle).toContain('ICM');
  });

  it('throws what the server refused, never an empty list', async () => {
    const provider = peopleProvider({
      searchDirectory: async () => {
        throw new Error('503');
      },
    });
    await expect(provider.search({ query: 'cam', limit: 3 })).rejects.toThrow('503');
  });
});

function held(
  id: string,
  displayName: string,
  conversationType: HeldConversation['conversationType'] = 'direct'
): HeldConversation {
  return {
    meta: { id, name: displayName, lifecycle: 'active', updatedAt: 0 },
    contactId: conversationType === 'direct' ? `peer-${id}` : '',
    displayName,
    displayNameResolved: true,
    conversationType,
    isReady: true,
    unreadCount: 0,
    imageMediaId: null,
  };
}

const text = (s: string) => serializeEnvelope({ kind: 'text', text: s });
const message = (conversationId: string, id: string, s: string, timestamp: number) =>
  ({ id, conversationId, senderId: 'u-a', content: text(s), timestamp }) as StoredMessage;

describe('Discussions', () => {
  function provider(conversations: HeldConversation[], store: Map<string, StoredMessage[]>) {
    const open = vi.fn();
    const index = new LocalMessageIndex(
      {
        conversationIds: async () => conversations.map((c) => c.meta.id),
        readMessages: async (id) => store.get(id) ?? [],
        readMessagesByIds: async (id, ids) =>
          (store.get(id) ?? []).filter((msg) => ids.includes(msg.id)),
      },
      () => {}
    );
    const p = discussionsProvider({
      conversations: async () => conversations,
      index: () => index,
      selfLabels: () => ['Camille DUPONT (Notes)', 'notes', 'mes notes'],
      open,
    });
    return { p, open, index };
  }

  it('lists the conversations by the NAME they show, then the messages, on the device', async () => {
    // The row's key is never what it is found by (SEARCH-6 of the cross-client campaign).
    const conversations = [held('g-1', 'Renée Lévêque'), held('g-2', 'Bureau', 'group')];
    const store = new Map([['g-2', [message('g-2', 'm-1', 'on attend Renée demain', 5)]]]);
    const { p, open, index } = provider(conversations, store);
    expect(p.source).toBe('device');
    await index.refresh();
    const answer = await p.search({ query: 'renee', limit: 10 });
    expect(answer.hits.map((h) => h.key)).toEqual(['conversation/g-1', 'message/g-2/m-1']);
    expect(answer.total).toBe(2);
    expect(answer.hits[1].snippet?.text).toContain('Renée');
    answer.hits[1].open?.();
    expect(open).toHaveBeenCalledWith('g-2');
    expect((await p.search({ query: 'g-1', limit: 10 })).hits).toEqual([]);
    index.discard();
  });

  it('finds "Mes notes" by the own name and by its old words', async () => {
    const { p, index } = provider([held('g-self', '', 'self')], new Map());
    const answer = await p.search({ query: 'notes', limit: 3 });
    expect(answer.hits.map((h) => h.title)).toEqual(['Camille DUPONT (Notes)']);
    index.discard();
  });

  it('keeps names first and fills the rest of the limit with messages', async () => {
    const conversations = [held('g-1', 'Gala'), held('g-2', 'Bureau', 'group')];
    const store = new Map([
      ['g-2', [message('g-2', 'a', 'le gala', 1), message('g-2', 'b', 'gala encore', 2)]],
    ]);
    const { p, index } = provider(conversations, store);
    await index.refresh();
    const answer = await p.search({ query: 'gala', limit: 2 });
    expect(answer.hits.map((h) => h.key)).toEqual(['conversation/g-1', 'message/g-2/b']);
    expect(answer.total).toBe(3);
    index.discard();
  });

  it('answers the NAMES at once, never waiting for the index, and the messages as it fills', async () => {
    const conversations = [held('g-1', 'Gala'), held('g-2', 'Bureau', 'group')];
    const store = new Map([['g-2', [message('g-2', 'a', 'le gala', 1)]]]);
    const { p, index } = provider(conversations, store);
    const first = await p.search({ query: 'gala', limit: 5 });
    expect(first.hits.map((h) => h.key)).toEqual(['conversation/g-1']);
    expect(first.partial).toBe(true);
    // The search this answer was given to is told again once the index is full.
    await index.refresh();
    const second = await p.search({ query: 'gala', limit: 5 });
    expect(second.hits.map((h) => h.key)).toEqual(['conversation/g-1', 'message/g-2/a']);
    expect(second.partial).toBe(false);
    index.discard();
  });

  it('answers names alone when no store is open', async () => {
    const p = discussionsProvider({
      conversations: async () => [held('g-1', 'Gala')],
      index: () => null,
      selfLabels: () => [],
      open: () => {},
    });
    expect((await p.search({ query: 'gala', limit: 3 })).hits).toHaveLength(1);
  });
});

describe('Communautés', () => {
  const workspaces = [
    {
      id: 'ws-1',
      name: 'Club Photo',
      avatarUserId: '',
      channels: [
        { id: 'channel_a', name: 'général' },
        { id: 'channel_b', name: 'photos de soirée' },
        { id: 'channel_c', name: 'photos privées', hasAccess: false },
      ],
    },
  ] as unknown as ChannelSidebarWorkspace[];

  it('finds a community and its readable salons, and opens the salon itself', async () => {
    const open = vi.fn();
    const p = communitiesProvider({ workspaces: () => workspaces, open });
    const answer = await p.search({ query: 'photo', limit: 5 });
    // "photos de soirée" starts with the word, "Club Photo" only has it: the salon ranks first.
    expect(answer.hits.map((h) => h.key)).toEqual(['salon/channel_b', 'community/ws-1']);
    expect(answer.hits[0].subtitle).toBe(m.search_salon_in({ community: 'Club Photo' }));
    answer.hits[1].open?.();
    expect(open).toHaveBeenCalledWith('channel_a');
    answer.hits[0].open?.();
    expect(open).toHaveBeenLastCalledWith('channel_b');
  });
});

describe('Associations', () => {
  it('matches the directory on the device, with a typo, and links the page', async () => {
    const directory = vi.fn(async () => [
      { id: 'a-1', name: 'Bureau des Élèves', slug: 'bde', description: 'Le BDE', logoUrl: null },
      { id: 'a-2', name: 'Club Théâtre', slug: 'theatre', description: null, logoUrl: '/l.png' },
    ]);
    const p = associationsProvider({
      directory: directory as unknown as () => Promise<Association[]>,
    });
    expect(p.source).toBe('list');
    const answer = await p.search({ query: 'theatr', limit: 3 });
    expect(answer.hits).toEqual([
      expect.objectContaining({ title: 'Club Théâtre', href: '/associations/theatre' }),
    ]);
    expect((await p.search({ query: 'eleves', limit: 3 })).hits[0].title).toBe('Bureau des Élèves');
    expect((await p.search({ query: 'theatte', limit: 3 })).hits).toHaveLength(1);
  });
});

describe('Événements', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const ev = (id: string, title: string, startsAt: string, kind = 'event') =>
    ({
      id,
      title,
      startsAt,
      kind,
      associationName: 'BDE',
      associationLogoUrl: null,
    }) as unknown as AssociationCalendarFeedEvent;

  it('reads the agenda window and puts the coming events first, soonest first', async () => {
    const agenda = vi.fn(async () => [
      ev('past', 'Soirée', '2026-10-01T20:00:00Z'),
      ev('later', 'Soirée', '2027-02-01T20:00:00Z'),
      ev('soon', 'Soirée', '2026-12-01T20:00:00Z'),
      ev('band', 'Soirée', '2026-12-02T00:00:00Z', 'break'),
    ]);
    const open = vi.fn();
    const p = eventsProvider({ agenda, now: () => now, open });
    const answer = await p.search({ query: 'soiree', limit: 5 });
    expect(agenda).toHaveBeenCalledWith(eventsWindow(now));
    expect(answer.hits.map((h) => h.key)).toEqual(['soon', 'later', 'past']);
    answer.hits[0].open?.();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'soon' }));
  });

  it('finds an event by its association too', async () => {
    const p = eventsProvider({
      agenda: async () => [ev('x', 'Gala', '2026-12-01T20:00:00Z')],
      now: () => now,
      open: () => {},
    });
    expect((await p.search({ query: 'bde', limit: 3 })).hits).toHaveLength(1);
  });
});

describe('Formulaires', () => {
  it('matches the managed forms, most recently updated first within a tier', async () => {
    const forms = [
      { id: 'f-1', title: 'Inscription gala', updatedAt: '2026-01-01', associationName: 'BDE' },
      { id: 'f-2', title: 'Inscription WEI', updatedAt: '2026-06-01', associationName: null },
    ] as unknown as Form[];
    const p = formsProvider({ forms: async () => forms });
    const answer = await p.search({ query: 'inscription', limit: 3 });
    expect(answer.hits.map((h) => h.href)).toEqual(['/forms/f-2', '/forms/f-1']);
  });
});

describe('Paramètres', () => {
  it('finds a section by a control its page draws, and leads to the section', async () => {
    const p = settingsProvider({ index: settingsSearchIndex });
    const answer = await p.search({ query: m.settings_language_label(), limit: 3 });
    expect(answer.hits[0]).toMatchObject({
      title: m.settings_language_label(),
      href: '/settings/preferences',
    });
    expect(p.source).toBe('device');
  });
});

describe('a post as a row of the overview', () => {
  const base = {
    id: 'p-1',
    markdown: '**Les places** pour le gala sont en vente !',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    createdAt: '2026-11-20T10:00:00.000Z',
    publishedAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
  } as unknown as PostEntity;

  it('has the shape of every row: who published it, the words around the match, when, where', () => {
    const hit = postSearchHit(
      { ...base, authorId: 'u-1', authorFirstName: 'Camille', authorLastName: 'Galand' },
      'gala'
    );
    expect(hit.title).toBe('Camille Galand');
    expect(hit.avatarUserId).toBe('u-1');
    expect(hit.snippet?.text).toBe('Les places pour le gala sont en vente !');
    expect(hit.snippet?.ranges).toEqual([[19, 23]]);
    expect(hit.subtitle).toBeTruthy();
    expect(hit.href).toBe('/posts/p-1');
    expect(hit.thumbnailUrl).toBeUndefined();
  });

  it('draws an association post under its logo, and an anonymous one under no face', () => {
    const asso = postSearchHit(
      {
        ...base,
        authorId: 'u-1',
        association: { id: 'a-1', name: 'BDE', slug: 'bde', logoUrl: null },
      },
      'gala'
    );
    expect(asso.title).toBe('BDE');
    expect(asso.avatarUserId).toBeUndefined();
    expect(asso.imageUrl).toBeNull();
    expect(asso.imageId).toBe('a-1');
    const anonymous = postSearchHit({ ...base, authorId: 'u-1', anonymous: true }, 'gala');
    expect(anonymous.title).toBe(m.post_anonymous_label());
    expect(anonymous.avatarUserId).toBeUndefined();
    expect(anonymous.imageUrl).toBeUndefined();
  });
});
