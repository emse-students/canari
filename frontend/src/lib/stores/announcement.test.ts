// @vitest-environment happy-dom
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
    localStorage.clear();
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
    await mod.refreshAnnouncement('u1');

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
    await mod.refreshAnnouncement('u1');

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
    await mod.refreshAnnouncement('u1');

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
    await mod.refreshAnnouncement('u1');

    expect(mod.getPendingAnnouncement()).toEqual({ id: 'a1', title: 'Titre', body: 'Corps' });
  });

  it('asks again on behalf of the next account once the state is reset', async () => {
    const announcement = {
      id: 'a1',
      titleFr: 'Titre',
      titleEn: 'Title',
      bodyFr: 'Corps',
      bodyEn: 'Body',
    };
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ announcement }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ announcement: null }) });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));

    const mod = await load();
    await mod.refreshAnnouncement('u1');
    // Same account, same opening: the latch holds.
    await mod.refreshAnnouncement('u1');
    expect(apiFetch).toHaveBeenCalledTimes(1);

    mod.resetAnnouncementState();
    // The first account's announcement is not left for the next one to see.
    expect(mod.getPendingAnnouncement()).toBeNull();
    await mod.refreshAnnouncement('u1');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("never lands the leaving account's answer for the next one", async () => {
    const announcement = {
      id: 'a-of-the-first-account',
      titleFr: 'Titre',
      titleEn: 'Title',
      bodyFr: 'Corps',
      bodyEn: 'Body',
    };
    let answerFirst: (value: unknown) => void = () => {};
    const apiFetch = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ announcement: null }) });
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));

    const mod = await load();
    const firstAsk = mod.refreshAnnouncement('u1');
    // The first account signs out while its ask is in flight, and the next one is asked for.
    mod.resetAnnouncementState();
    await mod.refreshAnnouncement('u1');
    answerFirst({ ok: true, json: async () => ({ announcement }) });
    await firstAsk;

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(mod.getPendingAnnouncement()).toBeNull();
  });
});

/**
 * SLOW-LINK CHANTIER, GAP 1 (2026-11-11): the ask waits for the token, which a cold start gets from
 * the session refresh (4 s on the owner's link). The announcement the server last listed is drawn
 * from the device at once - by the same client version only - and the answer replaces it.
 */
describe('refreshAnnouncement draws the device copy before the network answers', () => {
  const announcement = {
    id: 'a1',
    titleFr: 'Titre',
    titleEn: 'Title',
    bodyFr: 'Corps',
    bodyEn: 'Body',
  };
  let version = '0.14.0';
  const load = async () => {
    vi.resetModules();
    return import('./announcement.svelte');
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    version = '0.14.0';
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.doMock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://example.test' }));
    vi.doMock('$lib/utils/appVersion', () => ({ getClientAppVersion: () => version }));
    vi.doMock('$lib/paraglide/runtime', () => ({ getLocale: () => 'fr' }));
  });

  /** One opening: the server lists `a1`, then the process ends (the module is loaded again). */
  async function anOpeningThatListedIt() {
    vi.doMock('$lib/utils/apiFetch', () => ({
      apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ announcement }) }),
    }));
    const first = await load();
    await first.refreshAnnouncement('u1');
    expect(first.getPendingAnnouncement()?.id).toBe('a1');
  }

  it('is on screen at once while the network answers nothing, then the answer replaces it', async () => {
    await anOpeningThatListedIt();
    let answer: (value: unknown) => void = () => {};
    vi.doMock('$lib/utils/apiFetch', () => ({
      apiFetch: vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve))),
    }));
    const mod = await load();
    const asking = mod.refreshAnnouncement('u1');
    // Nothing has answered, not even the token: the modal is already decided.
    expect(mod.getPendingAnnouncement()?.id).toBe('a1');
    answer({ ok: true, json: async () => ({ announcement: null }) });
    await asking;
    // Read on another device meanwhile: the server's "none" closes it, and the copy goes.
    expect(mod.getPendingAnnouncement()).toBeNull();
    expect(localStorage.getItem('canari_announcement:v1:u1')).toBeNull();
  });

  it('a refusal keeps the copy (a 5xx is not "none"), and accuses the refusal', async () => {
    await anOpeningThatListedIt();
    vi.doMock('$lib/utils/apiFetch', () => ({
      apiFetch: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    }));
    const accused = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await load();
    await mod.refreshAnnouncement('u1');
    expect(mod.getPendingAnnouncement()?.id).toBe('a1');
    expect(String(accused.mock.calls[0][0])).toContain('503');
    expect(localStorage.getItem('canari_announcement:v1:u1')).not.toBeNull();
  });

  it('is not drawn by another client version, nor for another account', async () => {
    await anOpeningThatListedIt();
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch: () => new Promise(() => {}) }));
    version = '0.15.0';
    const upgraded = await load();
    void upgraded.refreshAnnouncement('u1');
    expect(upgraded.getPendingAnnouncement()).toBeNull();

    version = '0.14.0';
    const other = await load();
    void other.refreshAnnouncement('u2');
    expect(other.getPendingAnnouncement()).toBeNull();
  });

  it('a transport failure keeps the copy; a dismissal drops it and is not reopened by a late answer', async () => {
    await anOpeningThatListedIt();
    let answer: (value: unknown) => void = () => {};
    vi.doMock('$lib/utils/apiFetch', () => ({
      apiFetch: vi
        .fn()
        .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
        .mockResolvedValue({ ok: true }),
    }));
    const mod = await load();
    const asking = mod.refreshAnnouncement('u1');
    await mod.dismissAnnouncement();
    expect(localStorage.getItem('canari_announcement:v1:u1')).toBeNull();
    // The answer was computed before the "seen" landed: it still lists a1.
    answer({ ok: true, json: async () => ({ announcement }) });
    await asking;
    expect(mod.getPendingAnnouncement()).toBeNull();

    vi.doMock('$lib/utils/apiFetch', () => ({
      apiFetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    }));
    localStorage.setItem(
      'canari_announcement:v1:u1',
      JSON.stringify({ clientVersion: '0.14.0', announcement })
    );
    const offline = await load();
    await offline.refreshAnnouncement('u1');
    expect(offline.getPendingAnnouncement()?.id).toBe('a1');
  });
});
