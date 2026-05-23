import { generateAvatarColor, getInitials } from './avatar';
import type { Association, AssociationMember } from '$lib/associations/api';

/**
 * Renders the association trombinoscope to an A4 PDF and triggers a direct download.
 * Uses html2canvas + jsPDF; no new tab or print dialog.
 */
export async function exportTrombinoscope(
  asso: Association,
  members: AssociationMember[],
  resolvedMemberNames: Record<string, string>
): Promise<void> {
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    width: '794px',
    background: '#ffffff',
    padding: '40px',
    color: '#111111',
    fontFamily: '"Nunito", "Segoe UI", sans-serif',
    boxSizing: 'border-box',
  });

  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const logoHtml = asso.logoUrl
    ? `<img src="${asso.logoUrl}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
    : (() => {
        const bg = generateAvatarColor(asso.id);
        return `<div style="width:72px;height:72px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;flex-shrink:0;">${getInitials(asso.name)}</div>`;
      })();

  const cards = members
    .map((m) => {
      const name = resolvedMemberNames[m.userId] ?? m.displayName ?? m.userId;
      const role = m.role ?? 'Membre';
      const bg = generateAvatarColor(m.userId);
      const initials = getInitials(name);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;width:110px;">
          <div style="position:relative;width:72px;height:72px;border-radius:50%;overflow:hidden;flex-shrink:0;">
            <img src="/api/users/${encodeURIComponent(m.userId)}/avatar"
                 style="width:72px;height:72px;object-fit:cover;border-radius:50%;display:block;"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div style="display:none;position:absolute;inset:0;background:${bg};align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;border-radius:50%;">${initials}</div>
          </div>
          <p style="font-size:12px;font-weight:700;line-height:1.3;word-break:break-word;margin:0;">${safe(name)}</p>
          <p style="font-size:11px;color:#607188;margin:0;">${safe(role)}</p>
        </div>`;
    })
    .join('');

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:28px;padding-bottom:18px;border-bottom:2.5px solid #d9e0ea;">
      ${logoHtml}
      <h1 style="font-family:'Fredoka','Segoe UI',sans-serif;font-size:28px;font-weight:700;color:#122035;margin:0;">${safe(asso.name)}</h1>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:flex-start;">
      ${cards}
    </div>`;

  document.body.appendChild(container);

  try {
    // Wait for all images (avatars + logo)
    await Promise.all(
      Array.from(container.querySelectorAll<HTMLImageElement>('img')).map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) resolve();
            else {
              img.onload = () => resolve();
              img.onerror = () => resolve();
            }
          })
      )
    );

    await document.fonts.ready;

    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: false,
      backgroundColor: '#ffffff',
      logging: false,
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;

    if (imgH <= pageH) {
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);
    } else {
      // Split into A4 pages
      let yMm = 0;
      while (yMm < imgH) {
        if (yMm > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, -yMm, pageW, imgH);
        yMm += pageH;
      }
    }

    const filename = asso.name.replace(/[^a-zA-Z0-9À-ž\- ]/g, '_').trim();
    pdf.save(`${filename}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
