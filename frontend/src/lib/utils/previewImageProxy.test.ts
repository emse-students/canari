import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { proxiedPreviewImageUrl } = await import('$lib/utils/previewImageProxy');
const { ensurePreviewTicket, previewTicket } = await import('$lib/utils/previewTicket.svelte');

/** An answer shaped like the one `GET /api/mls/link-preview/ticket` gives. */
function ticketResponse(ticket: string, expiresInMs = 300_000) {
  return { ok: true, json: async () => ({ ticket, expiresInMs }) };
}

/**
 * THE IMAGE PROXY IS NOT OPEN ANY MORE, AND AN `<img>` IS WHY IT TOOK A TICKET TO CLOSE IT.
 *
 * `mls/link-preview/image` goes into an `<img src>`, so the browser makes the request itself and
 * carries no `Authorization` header - and on `tauri://localhost` no cookie either. Measured
 * 2026-09-10, that made Canari an image proxy for anybody who could name a URL. The session is now
 * proven once by an authenticated call, and the ticket carries that proof into the element.
 */
describe('proxiedPreviewImageUrl', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it('answers nothing at all while no ticket is held', () => {
    // Not a URL that would 401: every caller already treats '' as "no image", and a src certain to
    // be refused buys a console line per favicon candidate and nothing else.
    expect(proxiedPreviewImageUrl('https://example.com/cover.png')).toBe('');
  });

  it('leaves alone what it would never proxy, ticket or not', () => {
    // A data URI is already local, our own origin would only cost a second hop, and neither
    // depends on a session - so neither may be suppressed by the absence of a ticket.
    expect(proxiedPreviewImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(proxiedPreviewImageUrl(`${window.location.origin}/api/users/x/avatar`)).toBe(
      `${window.location.origin}/api/users/x/avatar`
    );
    expect(proxiedPreviewImageUrl(null)).toBe('');
  });

  it('carries the ticket once an authenticated call has minted one', async () => {
    apiFetch.mockResolvedValue(ticketResponse('deadbeef'));
    await ensurePreviewTicket();

    expect(previewTicket()).toBe('deadbeef');
    const url = proxiedPreviewImageUrl('https://example.com/cover.png');
    expect(url).toContain('/api/mls/link-preview/image?url=');
    expect(url).toContain('&t=deadbeef');
    expect(url).toContain(encodeURIComponent('https://example.com/cover.png'));
  });

  it('reuses the ticket it holds rather than minting one per image', async () => {
    // Deliberately reads the ticket the test above obtained: the module holds one for the page's
    // lifetime, so what is asserted here is that a second card costs no second request. The mock
    // was reset in `beforeEach`, so ANY call would show up.
    await ensurePreviewTicket();
    await ensurePreviewTicket();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(proxiedPreviewImageUrl('https://example.com/other.png')).toContain('&t=deadbeef');
  });
});
