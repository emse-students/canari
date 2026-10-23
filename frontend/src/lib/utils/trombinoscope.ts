import { generateAvatarColor, getInitials } from './avatar';
import { emojiHtml } from '$lib/utils/emojiSvg';
import { apiAssetUrl } from './apiUrl';
import { Log } from './Log';
import { exportSearchablePdf } from '$lib/pdf/searchableRaster';
import { escapeHtmlAttribute } from '$lib/utils/escapeHtml';
import { m as msg } from '$lib/paraglide/messages';
import {
  associationLogoSrc,
  type Association,
  type AssociationMember,
} from '$lib/associations/api';

/**
 * Renders the association trombinoscope to an A4 PDF and triggers a direct download.
 * Uses the searchable-raster pipeline: text marked with `data-pdf-text` is rendered as real
 * selectable vector text in the PDF over a pixel-faithful raster background.
 *
 * A member with no photo REMOVES its `<img>` rather than hiding it: the rasteriser substitutes an
 * `<img>` it cannot inline - hidden or not - with an in-flow box reading "img" (see `pdfRaster.ts`).
 */
export async function exportTrombinoscope(
  asso: Association,
  members: AssociationMember[],
  resolvedMemberNames: Record<string, string>
): Promise<void> {
  const PAGE_W = 794; // A4 portrait logical width in px

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: `${PAGE_W}px`,
    background: '#ffffff',
    padding: '40px',
    color: '#111111',
    fontFamily: '"Nunito Variable", "Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
  });

  container.innerHTML = buildTrombinoscopeHtml(asso, members, resolvedMemberNames);

  // A member with no photo shows the initials behind it. A listener and not an `onerror=` attribute:
  // the Content-Security-Policy refuses inline handlers (lib/security/cspPolicy.js). Attached before
  // the container joins the document, so an error that fires at once still finds it.
  for (const img of container.querySelectorAll<HTMLImageElement>('img[data-avatar-fallback]')) {
    img.addEventListener('error', () => showInitialsInstead(img), { once: true });
  }

  document.body.appendChild(container);

  try {
    // Measure the actual rendered height for multi-page support.
    const naturalHeight = container.scrollHeight;

    await exportSearchablePdf(container, {
      filename: asso.name,
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: PAGE_W,
      naturalHeight,
      rasterScale: 2,
      jpegQuality: 0.92,
      backgroundColor: '#ffffff',
      multiPage: true,
      fonts: ["700 28px 'Fredoka Variable'", "700 12px 'Nunito Variable'"],
    });
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * The trombinoscope sheet's markup, set as `innerHTML` by {@link exportTrombinoscope}.
 *
 * Every server-provided value is escaped where it is interpolated (`escapeHtmlAttribute`, or
 * `emojiHtml` for text that may carry emoji), and the logo goes through `associationLogoSrc`, which
 * draws only a path or an http(s) URL - a logo it refuses falls back to the initials, like no logo.
 */
export function buildTrombinoscopeHtml(
  asso: Association,
  members: AssociationMember[],
  resolvedMemberNames: Record<string, string>
): string {
  const safe = escapeHtmlAttribute;

  const logoSrc = associationLogoSrc(asso.logoUrl);
  const logoHtml = logoSrc
    ? `<img src="${safe(logoSrc)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
    : (() => {
        const bg = generateAvatarColor(asso.id);
        return `<div style="width:72px;height:72px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;flex-shrink:0;">${safe(getInitials(asso.name))}</div>`;
      })();

  const cards = members
    .map((m) => {
      const name = resolvedMemberNames[m.userId] ?? m.displayName ?? m.userId;
      const role = m.role ?? msg.asso_members_role_member();
      const bg = generateAvatarColor(m.userId);
      const initials = getInitials(name);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;width:110px;">
          <div style="position:relative;width:72px;height:72px;border-radius:50%;overflow:hidden;flex-shrink:0;">
            <img src="${apiAssetUrl(`/api/users/${encodeURIComponent(m.userId)}/avatar`)}"
                 style="width:72px;height:72px;object-fit:cover;border-radius:50%;display:block;"
                 data-avatar-fallback />
            <div style="display:none;position:absolute;inset:0;background:${bg};align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;border-radius:50%;">${safe(initials)}</div>
          </div>
          <p data-pdf-text style="font-size:12px;font-weight:700;line-height:1.3;word-break:break-word;margin:0;">${emojiHtml(name)}</p>
          <p data-pdf-text style="font-size:11px;color:#607188;margin:0;">${emojiHtml(role)}</p>
        </div>`;
    })
    .join('');

  const contactHtml = asso.contactEmail?.trim()
    ? `<p data-pdf-text style="font-size:13px;color:#607188;margin:4px 0 0 0;">${safe(asso.contactEmail.trim())}</p>`
    : '';

  return `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:28px;padding-bottom:18px;border-bottom:2.5px solid #d9e0ea;">
      ${logoHtml}
      <div>
        <h1 data-pdf-text style="font-family:'Fredoka Variable','Fredoka','Segoe UI',sans-serif;font-size:28px;font-weight:700;color:#151B2C;margin:0;">${emojiHtml(asso.name)}</h1>
        ${contactHtml}
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:flex-start;">
      ${cards}
    </div>`;
}

/**
 * Replaces a member photo that failed to load with the initials box that follows it. The `<img>` is
 * REMOVED rather than hidden: the rasteriser draws an `<img>` it cannot inline as a box reading "img"
 * (see the file header).
 */
export function showInitialsInstead(img: HTMLImageElement): void {
  Log.d('Trombinoscope', 'member photo did not load, initials drawn instead');
  const initials = img.nextElementSibling;
  if (initials instanceof HTMLElement) initials.style.display = 'flex';
  img.remove();
}
