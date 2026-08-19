import { parseAnnouncement, localizeAnnouncement } from './announcement.svelte';

/**
 * The client's whole job is to pick a language and refuse to render a blank modal. Both halves are
 * pure, so both are pinned here; everything else about the announcement (who has seen it, who it
 * applies to) is decided server-side by construction and tested there.
 */
describe('parseAnnouncement', () => {
  const valid = {
    id: 'a1',
    titleFr: 'Titre',
    titleEn: 'Title',
    bodyFr: 'Corps',
    bodyEn: 'Body',
  };

  it('accepts a complete announcement', () => {
    expect(parseAnnouncement(valid)).toEqual(valid);
  });

  it('refuses anything that would render as a blank modal', () => {
    // A modal with no way out and nothing in it is worse than no announcement.
    expect(parseAnnouncement(null)).toBeNull();
    expect(parseAnnouncement('nope')).toBeNull();
    expect(parseAnnouncement({})).toBeNull();
    for (const field of ['id', 'titleFr', 'titleEn', 'bodyFr', 'bodyEn'] as const) {
      expect(parseAnnouncement({ ...valid, [field]: '' })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: '   ' })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: undefined })).toBeNull();
      expect(parseAnnouncement({ ...valid, [field]: 42 })).toBeNull();
    }
  });

  it('reads "no announcement" as no announcement, not as a malformed one', () => {
    expect(parseAnnouncement(null)).toBeNull();
  });
});

describe('localizeAnnouncement', () => {
  const both = {
    id: 'a1',
    titleFr: 'Titre',
    titleEn: 'Title',
    bodyFr: 'Corps',
    bodyEn: 'Body',
  };

  it('picks the language the user chose inside Canari', () => {
    expect(localizeAnnouncement(both, 'fr')).toEqual({ id: 'a1', title: 'Titre', body: 'Corps' });
    expect(localizeAnnouncement(both, 'en')).toEqual({ id: 'a1', title: 'Title', body: 'Body' });
  });

  it('treats any locale that is not English as French, the base locale', () => {
    expect(localizeAnnouncement(both, '').title).toBe('Titre');
    expect(localizeAnnouncement(both, 'de').title).toBe('Titre');
  });
});

/**
 * The ASK, which is the half that was broken in production for weeks without anyone noticing.
 *
 * Two properties, and neither is about the announcement's content:
 *
 *   1. **The path has three segments.** `/api/users/announcement` was captured by
 *      `/api/users/:id`, registered earlier, and answered 404 for a user called "announcement".
 *      Two segments is the collision; a third cannot collide whatever the module order is.
 *   2. **A refusal is accused, not whispered.** A non-200 means the ASK failed. Reporting it the
 *      same way as the ordinary "nothing to show" case is what let a dead endpoint look like a
 *      quiet week, every opening, for weeks.
 */
describe('refreshAnnouncement', () => {
  const load = async () => {
    vi.resetModules();
    return import('./announcement.svelte');
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.doMock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://example.test' }));
    vi.doMock('$lib/utils/appVersion', () => ({ getClientAppVersion: () => '0.14.0' }));
    vi.doMock('$lib/paraglide/runtime', () => ({ getLocale: () => 'fr' }));
  });

  it('asks on a path that a two-segment :id route cannot capture', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ announcement: null }) });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));

    const mod = await load();
    await mod.refreshAnnouncement();

    const url: string = apiFetch.mock.calls[0][0];
    expect(url).toContain('/api/users/me/announcement');
    // The property, not the spelling: whatever the path becomes, it must not be `users/<word>`.
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    expect(segments.slice(0, 2)).toEqual(['api', 'users']);
    expect(segments.length).toBeGreaterThan(3);
  });

  it('accuses a refusal instead of reporting it as an ordinary quiet answer', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));
    const accused = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await load();
    await mod.refreshAnnouncement();

    expect(accused).toHaveBeenCalledTimes(1);
    expect(String(accused.mock.calls[0][0])).toContain('404');
    expect(mod.getPendingAnnouncement()).toBeNull();
  });

  it('stays quiet when the server simply has nothing to show', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ announcement: null }) });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));
    const accused = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await load();
    await mod.refreshAnnouncement();

    // 200 + null is the ordinary case and must never look like a failure.
    expect(accused).not.toHaveBeenCalled();
    expect(mod.getPendingAnnouncement()).toBeNull();
  });

  it('reads the announcement out of the envelope', async () => {
    // The envelope exists so that "none" can be SAID. A bare `null` return makes Nest send an empty
    // body, and `res.json()` then throws on the ordinary case - which is how a repaired route still
    // showed nothing, and reported a parse error while doing it.
    const announcement = {
      id: 'a1',
      titleFr: 'Titre',
      titleEn: 'Title',
      bodyFr: 'Corps',
      bodyEn: 'Body',
    };
    const apiFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ announcement }) });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));

    const mod = await load();
    await mod.refreshAnnouncement();

    expect(mod.getPendingAnnouncement()).toEqual({ id: 'a1', title: 'Titre', body: 'Corps' });
  });
});
