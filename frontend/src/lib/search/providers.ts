/**
 * THE SECTIONS OF THE UNIVERSAL SEARCH, ONE PROVIDER EACH (owner, 2026-11-26). Each reuses the read
 * its own page already makes - no second endpoint, no second matcher - and says where it answers from
 * (`SearchSource`): the split is on `docs/wiki/frontend/universal-search.md`.
 *
 * Every dependency is handed in, so a test drives a provider with plain functions and the page wires
 * the real ones once (`universalSearchProviders` in `wiring.ts`).
 */
import { m } from '$lib/paraglide/messages';
import type { HeldConversation } from '$lib/utils/chat/heldConversations';
import type { ChannelSidebarWorkspace } from '$lib/composables/useChannelWorkspaces.svelte';
import type { DirectorySearchResult } from '$lib/profile/api';
import type { Association, AssociationCalendarFeedEvent } from '$lib/associations/api';
import type { Form } from '$lib/forms/api';
import type { PostEntity } from '$lib/posts/api';
import { postAuthorName } from '$lib/posts/postAuthorName';
import { markdownToPlainText } from '$lib/seo/text';
import { placeholderDataUrl } from '$lib/utils/mediaPlaceholder';
import type { SettingsSearchEntry } from '$lib/settings/settingsSections';
import { directoryUserFacts } from '$lib/directory/userFacts';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { exactDate, timeAgo } from '$lib/utils/time';
import { foldQuery, rankByLabels } from './rank';
import { snippetAround } from './snippet';
import type { LocalMessageIndex } from './localMessageIndex';
import type { SearchHit, SearchProvider } from './types';

/** Personnes: the directory's own query, ranked by the server (`userSearch.ts`, trigram). */
export function peopleProvider(deps: {
  searchDirectory: (p: { q: string; limit: number }) => Promise<DirectorySearchResult>;
}): SearchProvider {
  return {
    section: 'people',
    source: 'server',
    async search({ query, limit }) {
      const res = await deps.searchDirectory({ q: query.trim(), limit });
      return {
        total: res.total,
        hits: res.users.map((u) => ({
          key: u.id,
          title: u.displayName?.trim() || getUserDisplayNameSync(u.id, m.user_unknown_label()),
          subtitle: directoryUserFacts(u).join(' · ') || undefined,
          href: `/profile/${encodeURIComponent(u.id)}`,
          avatarUserId: u.id,
        })),
      };
    },
  };
}

/** What the Discussions provider reads, all on the device. */
export interface DiscussionsDeps {
  /** The direct and group conversations held, most recent first (`heldConversations.ts`). */
  conversations: () => Promise<HeldConversation[]>;
  /** The open local message index, or null when no store is open (nobody signed in). */
  index: () => LocalMessageIndex | null;
  /** The labels "Mes notes" answers to: its title and its aliases. */
  selfLabels: () => string[];
  /** Opens a conversation by its map key (the MLS group id). */
  open: (conversationId: string) => void;
}

/**
 * Discussions: conversation NAMES first (ranked, then most recent), then the MESSAGES holding every
 * typed word, newest first. Both read only what the device holds; the query never leaves it. The
 * names never wait for the message index: what it holds is answered now, flagged `partial` while it
 * fills.
 */
export function discussionsProvider(deps: DiscussionsDeps): SearchProvider {
  return {
    section: 'discussions',
    source: 'device',
    async search({ query, limit }) {
      const q = foldQuery(query);
      const conversations = await deps.conversations();
      const byId = new Map(conversations.map((c) => [c.meta.id, c]));
      const named = rankByLabels(conversations, q, (c) =>
        c.conversationType === 'self' ? deps.selfLabels() : [c.displayName]
      );
      const nameHits: SearchHit[] = named.map((c) => ({
        key: `conversation/${c.meta.id}`,
        title: c.conversationType === 'self' ? deps.selfLabels()[0] : c.displayName,
        subtitle: c.lastActivityAt ? timeAgo(new Date(c.lastActivityAt).toISOString()) : undefined,
        avatarUserId: conversationAvatar(c),
        open: () => deps.open(c.meta.id),
      }));
      const index = deps.index();
      let messageHits: SearchHit[] = [];
      let messageTotal = 0;
      let partial = false;
      if (index) {
        // NEVER AWAITED: the names answer now, and the messages arrive as the index fills - it tells
        // the search again as it reads (`LocalMessageIndex.filling`).
        if (index.wants(conversations.map((c) => c.meta.id))) {
          index
            .refresh()
            .catch((e: unknown) =>
              console.error(`[SEARCH] the local index did not fill: ${String(e).slice(0, 200)}`)
            );
        }
        partial = index.filling;
        const room = Math.max(0, limit - nameHits.length);
        const found = index.search(q, room);
        messageTotal = found.total;
        messageHits = found.hits.flatMap((hit) => {
          const conv = byId.get(hit.conversationId);
          if (!conv) return [];
          const title = conv.conversationType === 'self' ? deps.selfLabels()[0] : conv.displayName;
          return [
            {
              key: `message/${hit.conversationId}/${hit.id}`,
              title,
              subtitle: timeAgo(new Date(hit.at).toISOString()),
              snippet: snippetAround(hit.text, q),
              avatarUserId: conversationAvatar(conv),
              open: () => deps.open(hit.conversationId),
            },
          ];
        });
      }
      return {
        hits: [...nameHits, ...messageHits].slice(0, limit),
        total: nameHits.length + messageTotal,
        partial,
      };
    },
  };
}

/**
 * A message row shows its CONVERSATION's face, the one its name row and the chat list show - never
 * the sender's. A sender's face is a request for that member's avatar (and name), so drawing it
 * would tell the server which members wrote the messages that matched (charter principle 1); the
 * conversation's face is one the chat list already loaded. A group shows the section's icon.
 */
function conversationAvatar(conv: HeldConversation): string | undefined {
  return conv.conversationType === 'group' ? undefined : conv.contactId || undefined;
}

/** Communautés: the communities the reader belongs to and their salons, as the device holds them. */
export function communitiesProvider(deps: {
  workspaces: () => readonly ChannelSidebarWorkspace[];
  /** Opens a salon (a `channel_` conversation id), or the communities tab when `null`. */
  open: (channelConversationId: string | null) => void;
}): SearchProvider {
  return {
    section: 'communities',
    source: 'device',
    async search({ query, limit }) {
      const q = foldQuery(query);
      type Row = { key: string; label: string; subtitle?: string; target: string | null };
      const rows: Row[] = [];
      for (const ws of deps.workspaces()) {
        const first = ws.channels.find((c) => c.hasAccess !== false) ?? null;
        rows.push({ key: `community/${ws.id}`, label: ws.name, target: first?.id ?? null });
      }
      for (const ws of deps.workspaces()) {
        for (const ch of ws.channels) {
          if (ch.hasAccess === false) continue;
          rows.push({
            key: `salon/${ch.id}`,
            label: ch.name,
            subtitle: m.search_salon_in({ community: ws.name }),
            target: ch.id,
          });
        }
      }
      const ranked = rankByLabels(rows, q, (r) => [r.label]);
      return {
        total: ranked.length,
        hits: ranked.slice(0, limit).map((r) => ({
          key: r.key,
          title: r.label,
          subtitle: r.subtitle,
          open: () => deps.open(r.target),
        })),
      };
    },
  };
}

/** Associations: the directory the associations page reads, matched on the device. */
export function associationsProvider(deps: {
  directory: () => Promise<Association[]>;
}): SearchProvider {
  return {
    section: 'associations',
    source: 'list',
    async search({ query, limit }) {
      const ranked = rankByLabels(await deps.directory(), query, (a) => [a.name]);
      return {
        total: ranked.length,
        hits: ranked.slice(0, limit).map((a) => ({
          key: a.id,
          title: a.name,
          subtitle: a.description?.trim() || undefined,
          href: `/associations/${encodeURIComponent(a.slug)}`,
          imageUrl: a.logoUrl,
        })),
      };
    },
  };
}

/** How far back and ahead the Événements section reads the agenda. */
export const EVENTS_WINDOW = { pastDays: 90, futureDays: 365 } as const;

/**
 * The agenda window the Événements section reads, from `now`: the recent past (a reader looking for
 * last month's gala) and the coming year.
 */
export function eventsWindow(now: Date): { from: string; to: string } {
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(now.getTime() - EVENTS_WINDOW.pastDays * day).toISOString(),
    to: new Date(now.getTime() + EVENTS_WINDOW.futureDays * day).toISOString(),
  };
}

/**
 * Événements: the reader's own agenda over {@link EVENTS_WINDOW}, matched on the device by title and
 * association. Within a tier, the coming events first (soonest first), then the past ones (latest
 * first): the next one is the one a reader most likely wants.
 */
export function eventsProvider(deps: {
  agenda: (window: { from: string; to: string }) => Promise<AssociationCalendarFeedEvent[]>;
  now: () => Date;
  open: (event: AssociationCalendarFeedEvent) => void;
}): SearchProvider {
  return {
    section: 'events',
    source: 'list',
    async search({ query, limit }) {
      const now = deps.now();
      const events = (await deps.agenda(eventsWindow(now))).filter((e) => e.kind !== 'break');
      const t = now.getTime();
      const ordered = [...events].sort((a, b) => {
        const ta = new Date(a.startsAt).getTime();
        const tb = new Date(b.startsAt).getTime();
        const fa = ta >= t;
        const fb = tb >= t;
        if (fa !== fb) return fa ? -1 : 1;
        return fa ? ta - tb : tb - ta;
      });
      const ranked = rankByLabels(ordered, query, (e) => [e.title, e.associationName]);
      return {
        total: ranked.length,
        hits: ranked.slice(0, limit).map((e) => ({
          key: e.id,
          title: e.title,
          subtitle: [exactDate(e.startsAt), e.associationName].filter(Boolean).join(' · '),
          imageUrl: e.associationLogoUrl,
          open: () => deps.open(e),
        })),
      };
    },
  };
}

/** Formulaires: the forms the reader manages (the list `/forms` draws), matched on the device. */
export function formsProvider(deps: { forms: () => Promise<Form[]> }): SearchProvider {
  return {
    section: 'forms',
    source: 'list',
    async search({ query, limit }) {
      const forms = [...(await deps.forms())].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      const ranked = rankByLabels(forms, query, (f) => [f.title, f.associationName ?? '']);
      return {
        total: ranked.length,
        hits: ranked.slice(0, limit).map((f) => ({
          key: f.id,
          title: f.title,
          subtitle: f.associationName ?? undefined,
          href: `/forms/${encodeURIComponent(f.id)}`,
        })),
      };
    },
  };
}

/**
 * ONE POST AS A ROW OF THE OVERVIEW, the same shape as every other section's (owner, 2026-11-26:
 * *"une app homogène"*): who published it (the post header's own resolver, `postAuthorName`, with
 * its face or logo - none for "Anonyme"), the words around the match, when it was published, and its
 * first picture as the ThumbHash the post already carries (painted from the post itself, so the row
 * fetches nothing). It opens the post's page; the Posts chip draws the feed's full cards instead.
 */
export function postSearchHit(post: PostEntity, query: string): SearchHit {
  const plain = markdownToPlainText(post.markdown ?? '');
  const first = post.media?.find((media) => media.type === 'image' || media.type === 'video');
  return {
    key: `post/${post.id}`,
    title: postAuthorName(post),
    snippet: plain ? snippetAround(plain, foldQuery(query)) : undefined,
    subtitle: timeAgo(post.publishedAt || post.createdAt),
    href: `/posts/${encodeURIComponent(post.id)}`,
    avatarUserId: post.association || post.anonymous ? undefined : post.authorId || undefined,
    imageUrl: post.association ? (post.association.logoUrl ?? null) : undefined,
    imageId: post.association?.id,
    thumbnailUrl: placeholderDataUrl(first?.placeholder) ?? undefined,
  };
}

/** Paramètres: the static index of the settings pages (`settingsSearchIndex`). */
export function settingsProvider(deps: { index: () => SettingsSearchEntry[] }): SearchProvider {
  return {
    section: 'settings',
    source: 'device',
    async search({ query, limit }) {
      const ranked = rankByLabels(deps.index(), query, (e) => [e.label]);
      return {
        total: ranked.length,
        hits: ranked.slice(0, limit).map((e) => ({
          key: `${e.section}/${e.label}`,
          title: e.label,
          subtitle: e.label === e.sectionLabel ? undefined : e.sectionLabel,
          href: e.href,
        })),
      };
    },
  };
}
